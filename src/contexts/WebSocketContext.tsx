import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '../utils/api';

import { ChatOutbox, isChatSend, type OutboxEntry } from './chatOutbox';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop, and `chat_send_failed`
 * when a chat message never got the server's receipt (see chatOutbox.ts).
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  /** Метка работы события — см. chat/utils/liveRunCursor. */
  runStartedAt?: number | null;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames can never be coalesced or
   * dropped the way a single "latest message" state slot could.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  /**
   * Legacy state-based access to the most recent frame.
   *
   * Kept only for low-frequency consumers (TaskMaster broadcasts). High-rate
   * chat streams must use `subscribe` — React may batch state updates, which
   * makes `latestMessage` lossy under load.
   */
  latestMessage: ServerEvent | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

/**
 * Сколько ждать расписку сервера. Сервер расписывается сразу после приёма,
 * до обращения к модели, — десятка секунд без неё значит, что связь
 * «полумёртвая»: считается открытой, а данные не ходят (iPhone после фона).
 */
const ACK_TIMEOUT_MS = 10_000;
/** Как часто проверять очередь, пока в ней что-то есть. */
const OUTBOX_CHECK_MS = 3_000;
/** Соединение, не открывшееся за это время, пересоздаётся. */
const CONNECT_STALL_MS = 15_000;

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const createOutbox = (): ChatOutbox => {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return new ChatOutbox(storage);
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [latestMessage, setLatestMessage] = useState<ServerEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();
  // Очередь сообщений чата, ждущих расписки сервера (см. chatOutbox.ts).
  const outboxRef = useRef<ChatOutbox | null>(null);
  if (!outboxRef.current) {
    outboxRef.current = createOutbox();
  }
  const outboxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectStartedAtRef = useRef(0);
  const connectRef = useRef<() => void>(() => {});

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
    setLatestMessage(event);
  }, []);

  /** Отправка сообщения из очереди; `false` — сокет не принял данные. */
  const transmit = useCallback((socket: WebSocket, entry: OutboxEntry): boolean => {
    try {
      socket.send(JSON.stringify(entry.message));
      outboxRef.current?.markSent(entry.id);
      return true;
    } catch (error) {
      console.warn('[outbox] сокет не принял сообщение:', error);
      return false;
    }
  }, []);

  /** Честный отказ по сообщениям, которые больше не досылаются. */
  const reportGivenUp = useCallback(() => {
    for (const entry of outboxRef.current?.takeGivenUp(ACK_TIMEOUT_MS) ?? []) {
      console.warn('[outbox] сообщение так и не получило расписку сервера', entry.id);
      dispatch({
        kind: 'chat_send_failed',
        sessionId: typeof entry.message.sessionId === 'string' ? entry.message.sessionId : undefined,
        clientMessageId: entry.id,
        content: entry.message.content,
        timestamp: Date.now(),
      });
    }
  }, [dispatch]);

  /**
   * Бросить текущее соединение и открыть новое, не дожидаясь `onclose`: у
   * «полумёртвого» сокета на iPhone он может не прийти никогда.
   */
  const forceReconnect = useCallback((reason: string) => {
    if (unmountedRef.current) return;
    console.warn(`[outbox] пересоздаю соединение: ${reason}`);
    const stale = wsRef.current;
    if (stale) {
      stale.onopen = null;
      stale.onmessage = null;
      stale.onclose = null;
      stale.onerror = null;
      try {
        stale.close();
      } catch {
        // закрываем мёртвое — ошибка не важна
      }
    }
    wsRef.current = null;
    setIsConnected(false);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    connectRef.current();
  }, []);

  const scheduleOutboxCheck = useCallback(() => {
    if (outboxTimerRef.current || unmountedRef.current) return;
    outboxTimerRef.current = setTimeout(() => {
      outboxTimerRef.current = null;
      const outbox = outboxRef.current;
      if (!outbox || outbox.size === 0 || unmountedRef.current) return;

      reportGivenUp();
      if (outbox.size === 0) return;

      const socket = wsRef.current;
      if (!socket) {
        if (!reconnectTimeoutRef.current) connectRef.current();
      } else if (socket.readyState === WebSocket.OPEN) {
        if (outbox.overdue(ACK_TIMEOUT_MS).length > 0) {
          forceReconnect('нет расписки сервера о получении сообщения');
        }
      } else if (socket.readyState === WebSocket.CONNECTING) {
        if (Date.now() - connectStartedAtRef.current > CONNECT_STALL_MS) {
          forceReconnect('соединение не устанавливается');
        }
      } else {
        // CLOSING/CLOSED без onclose — так бывает у сокета, уснувшего в фоне.
        forceReconnect('соединение закрыто без уведомления');
      }
      scheduleOutboxCheck();
    }, OUTBOX_CHECK_MS);
  }, [forceReconnect, reportGivenUp]);

  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();
    // Сообщения, не получившие расписку до перезагрузки страницы, дошлются.
    if ((outboxRef.current?.size ?? 0) > 0) {
      scheduleOutboxCheck();
    }

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (outboxTimerRef.current) {
        clearTimeout(outboxTimerRef.current);
        outboxTimerRef.current = null;
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
    };
  }, [isAuthLoading, token, user]); // reconnect after authentication or token refresh

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;
      connectStartedAtRef.current = Date.now();

      websocket.onopen = () => {
        setIsConnected(true);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;

        // Всё, что не получило расписку, уходит заново по новой связи. Сервер
        // узнаёт уже принятое по номеру и второй запуск не заводит.
        reportGivenUp();
        const outbox = outboxRef.current;
        if (outbox && outbox.size > 0) {
          for (const entry of outbox.pending()) {
            if (!transmit(websocket, entry)) break;
          }
          scheduleOutboxCheck();
        }
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          if (data.kind === 'chat_send_ack') {
            outboxRef.current?.settle(data.clientMessageId);
            return;
          }
          if (data.kind === 'protocol_error' && data.clientMessageId) {
            // Сервер отказал именно этому сообщению — досылать бессмысленно.
            outboxRef.current?.settle(data.clientMessageId);
          }
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        setIsConnected(false);
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, token, user, reportGivenUp, transmit, scheduleOutboxCheck]); // reconnect with current authentication state
  connectRef.current = connect;

  // Приложение вернулось из фона или появилась сеть. Если есть сообщения без
  // расписки, связи не доверяем: на iPhone сокет после сна часто числится
  // открытым, но мёртв, — открываем новый и досылаем.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState === 'hidden') return;
      const outbox = outboxRef.current;
      if (!outbox || outbox.size === 0) return;
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN && outbox.overdue(0).length > 0) {
        forceReconnect('приложение вернулось из фона, сообщение ждёт расписки');
      } else {
        scheduleOutboxCheck();
      }
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('online', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('online', onResume);
    };
  }, [forceReconnect, scheduleOutboxCheck]);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (isChatSend(message)) {
      // Сообщение чата не выбрасывается никогда: оно ждёт в очереди, пока
      // сервер не распишется в получении.
      const entry = outboxRef.current!.add(message);
      if (socket && socket.readyState === WebSocket.OPEN) {
        if (!transmit(socket, entry)) {
          forceReconnect('сокет не принял сообщение');
        }
      } else {
        console.warn('WebSocket not connected — сообщение ждёт в очереди');
      }
      scheduleOutboxCheck();
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, [forceReconnect, scheduleOutboxCheck, transmit]);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    latestMessage,
    isConnected
  }), [sendMessage, subscribe, latestMessage, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
