import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { clearQueuedMessages, readQueuedMessages } from '../utils/chatStorage';

/** Строка очереди в том виде, в каком её присылает сервер. */
export type ServerQueuedMessage = {
  id: string;
  content: string;
  attachments: unknown[];
  createdAt: string;
};

/**
 * Очередь сообщений открытого чата — в том виде, в каком её хранит СЕРВЕР.
 *
 * Раньше очередь жила в localStorage вкладки, и отправляла её страница: чат
 * освободился — вкладка заметила и послала следующее. Пока сайт закрыт,
 * замечать было некому (Егор 20.09.26: «оно выложилось только тогда, когда я
 * вошёл в сайт»). Теперь очередь держит сервер и отправляет сам, а страница
 * её только показывает и правит:
 *
 * — состояние приходит в ответе на подписку (`chat_subscribed.queue`) и в
 *   рассылке `chat_queue` после любого изменения — с любого устройства;
 * — «убрать», «переставить», «очистить» уходят на сервер сообщениями
 *   `chat.queue.*`; своего порядка вкладка не придумывает;
 * — очередь, оставшаяся в этом браузере от прежней сборки, при первом
 *   открытии чата досылается на сервер обычным `chat.send` — иначе
 *   подготовленные сообщения пропали бы молча.
 */
export function useSessionMessageQueue(sessionId: string | null) {
  const { subscribe, sendMessage } = useWebSocket();
  const [queue, setQueue] = useState<ServerQueuedMessage[]>([]);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Чужую очередь не показываем ни мгновения: при переключении чата список
  // очищается до прихода состояния нового.
  useEffect(() => {
    setQueue([]);
  }, [sessionId]);

  useEffect(() => {
    return subscribe((event) => {
      const eventSessionId = typeof event?.sessionId === 'string' ? event.sessionId : '';
      if (!eventSessionId || eventSessionId !== sessionIdRef.current) {
        return;
      }
      if (event.kind !== 'chat_queue' && event.kind !== 'chat_subscribed') {
        return;
      }
      const incoming = (event as { queue?: unknown }).queue;
      if (!Array.isArray(incoming)) {
        return;
      }
      setQueue(
        incoming.filter(
          (item): item is ServerQueuedMessage =>
            Boolean(item) && typeof item === 'object' && typeof (item as ServerQueuedMessage).id === 'string',
        ),
      );
    });
  }, [subscribe]);

  // Переезд очереди из браузера на сервер. Разовый шаг после обновления
  // сборки: что лежало в этой вкладке, уходит обычной отправкой — занятый чат
  // положит её в серверную очередь сам.
  const migratedSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!sessionId || migratedSessionsRef.current.has(sessionId)) {
      return;
    }
    migratedSessionsRef.current.add(sessionId);
    const leftovers = readQueuedMessages(sessionId);
    if (leftovers.length === 0) {
      return;
    }
    clearQueuedMessages(sessionId);
    leftovers.forEach((item) => {
      sendMessage({
        type: 'chat.send',
        sessionId,
        content: item.content,
        options: { ...(item.options ?? {}), attachments: item.attachments ?? item.images ?? [] },
      });
    });
  }, [sendMessage, sessionId]);

  const removeQueued = useCallback((id: string) => {
    const session = sessionIdRef.current;
    if (!session) return;
    // Убираем сразу, не дожидаясь рассылки: нажатие должно отзываться мгновенно.
    setQueue((prev) => prev.filter((item) => item.id !== id));
    sendMessage({ type: 'chat.queue.remove', sessionId: session, id });
  }, [sendMessage]);

  const reorderQueued = useCallback((ids: string[]) => {
    const session = sessionIdRef.current;
    if (!session) return;
    setQueue((prev) => {
      const byId = new Map(prev.map((item) => [item.id, item]));
      const next = ids.map((id) => byId.get(id)).filter((item): item is ServerQueuedMessage => Boolean(item));
      const rest = prev.filter((item) => !ids.includes(item.id));
      return [...next, ...rest];
    });
    sendMessage({ type: 'chat.queue.reorder', sessionId: session, ids });
  }, [sendMessage]);

  // «Сейчас»: сервер передаёт сообщение в идущий ход, не дожидаясь конца.
  // Из списка убираем сразу; не выйдет — сервер вернёт строку рассылкой
  // очереди и объяснит почему.
  const sendNowQueued = useCallback((id: string) => {
    const session = sessionIdRef.current;
    if (!session) return;
    setQueue((prev) => prev.filter((item) => item.id !== id));
    sendMessage({ type: 'chat.queue.sendNow', sessionId: session, id });
  }, [sendMessage]);

  const clearQueued = useCallback(() => {
    const session = sessionIdRef.current;
    if (!session) return;
    setQueue([]);
    sendMessage({ type: 'chat.queue.clear', sessionId: session });
  }, [sendMessage]);

  return { queue, removeQueued, reorderQueued, clearQueued, sendNowQueued };
}
