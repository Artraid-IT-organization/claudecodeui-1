import { useEffect, useRef } from 'react';
import type { ActivityPhase } from '../../../hooks/useSessionProtection';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '../../../utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import type { PendingPermissionRequest } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import { noteRun } from '../utils/liveRunCursor';
import { isSubagentToolName } from '../tools/configs/toolConfigs';
import { toolInputDescription } from '../utils/workStretch';
import { reportCatchupProbe } from '../utils/catchupProbe';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

interface UseChatRealtimeHandlersArgs {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /** All five are keyed by session id — see the comment on their declaration
   *  in ChatInterface: one client can stream two sessions at once. */
  streamTimerRef: MutableRefObject<Map<string, number>>;
  accumulatedStreamRef: MutableRefObject<Map<string, string>>;
  /** Mirrors streamTimerRef/accumulatedStreamRef for the live thinking block. */
  thinkingStreamTimerRef: MutableRefObject<Map<string, number>>;
  accumulatedThinkingRef: MutableRefObject<Map<string, string>>;
  /** When the current thinking block's first delta arrived; drives the measured "Thought for Ns". */
  thinkingStartedAtRef: MutableRefObject<Map<string, number>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean, reason?: string) => Promise<void>;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamTimerRef,
  accumulatedStreamRef,
  thinkingStreamTimerRef,
  accumulatedThinkingRef,
  thinkingStartedAtRef,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  // Идентификаторы незавершённых запусков суб-агентов (инструмент Task) на
  // сессию. Живёт в ref, а не в состоянии: обновляется на каждом событии
  // потока и не должен вызывать перерисовку сам по себе — подпись меняет
  // onSessionProcessing.
  const activeAgentsRef = useRef<Map<string, Set<string>>>(new Map());

  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Every sequenced live event carries a monotonic per-run `seq`. Track
      // the highest one seen per session so a reconnect's `chat.subscribe`
      // replays only what this client actually missed — and, just as
      // importantly, DROP a message whose `seq` this client has already
      // applied instead of only recording progress and falling through.
      //
      // Two independent effects can each send `chat.subscribe` around one
      // reconnect (ChatInterface's `handleWebSocketReconnect`, gated behind
      // an awaited REST call, and useChatSessionState's `ws`-keyed subscribe
      // effect, which fires synchronously as soon as the context's `ws`
      // reference updates). If the second one reads `lastSeqRef` before the
      // first has caught the client up, the server's `chat.subscribe` reply
      // (chat-websocket.service.ts `handleChatSubscribe`) replays a block
      // that is already in flight to the same socket via the run's normal
      // live broadcast — the same `stream_delta`/`thinking_delta` run then
      // arrives twice. Without this guard each duplicate re-runs
      // `accumulatedStreamRef.current += text` / `accumulatedThinkingRef.
      // current += text`, splicing a repeated fragment into the middle of
      // the live buffer (observed live: "I'll look at the file first."
      // replayed from partway through corrupted the buffer into "I'll
      // look'll look at the file first."), which then gets persisted as-is
      // by `finalizeStreaming`/`finalizeThinkingStreaming` — a bug no
      // content-based dedup in useSessionStore can catch, because the
      // corruption happens before the row is ever finalized. Rejecting an
      // already-seen `seq` up front makes every sequenced kind (not just
      // deltas) idempotent under duplicate delivery, matching the server's
      // own "unique monotonic seq" contract.
      if (sid && typeof msg.seq === 'number') {
        // Новая работа — счёт номеров заново, иначе её события выбросятся
        // как «уже виденные» (см. liveRunCursor).
        noteRun(sid, msg.runStartedAt, lastSeqRef.current);
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq <= known) {
          return;
        }
        lastSeqRef.current.set(sid, msg.seq);
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          // Ответ на подписку тоже несёт метку работы: досылка пропущенного
          // идёт сразу после него и должна приниматься с нуля.
          noteRun(sid, msg.runStartedAt, lastSeqRef.current);

          if (sid === activeViewSessionId) {
            reportCatchupProbe({
              reason: 'subscribe-ack',
              processing: Boolean(msg.isProcessing),
              serverSeq: typeof msg.lastSeq === 'number' ? msg.lastSeq : -1,
              clientSeq: lastSeqRef.current.get(sid) ?? 0,
              visible: document.visibilityState === 'visible',
            });
          }

          if (msg.isProcessing) {
            // Этап приходит только для чата, пережившего перезапуск сайта
            // (сервер читает хвост переписки); у живого — из потока.
            onSessionProcessing?.(sid, typeof msg.phase === 'string'
              ? {
                phase: msg.phase as ActivityPhase,
                detail: typeof msg.phaseDetail === 'string' ? msg.phaseDetail : null,
                statusText: null,
              }
              : undefined);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'chat_send_waiting': {
          // Сервер не взял сообщение из-за предела одновременных чатов
          // (contexts/chatOutbox.ts): оно ждёт в очереди и уйдёт само. Чат
          // остаётся «занятым» — новые сообщения встанут за этим, а не вперёд.
          if (sid) {
            const limit = typeof msg.limit === 'number' ? msg.limit : null;
            const busy = limit ? `Сейчас уже работают ${limit} чатов` : 'Сейчас уже работает предельное число чатов';
            sessionStore.appendRealtime(sid, {
              id: `send_waiting_${String(msg.clientMessageId || Date.now())}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'task_notification',
              status: 'running',
              summary: `${busy}. Сообщение не потеряно: оно ждёт и отправится само, как только один из них закончит.`,
            } as NormalizedMessage);
          }
          return;
        }

        case 'chat_send_waiting_done': {
          if (sid) {
            sessionStore.appendRealtime(sid, {
              id: `send_waiting_done_${String(msg.clientMessageId || Date.now())}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'task_notification',
              status: 'completed',
              summary: 'Место освободилось — сообщение отправлено.',
            } as NormalizedMessage);
          }
          return;
        }

        case 'chat_send_failed': {
          // Сообщение так и не получило расписку сервера (contexts/chatOutbox.ts):
          // сказать прямо и вернуть текст, а не делать вид, что оно ушло.
          if (sid) {
            onSessionIdle?.(sid);
            const text = typeof msg.content === 'string' ? msg.content.trim() : '';
            const notice = 'Сообщение не дошло до сервера — связь так и не восстановилась. Отправьте его ещё раз.';
            sessionStore.appendRealtime(sid, {
              id: `send_failed_${String(msg.clientMessageId || Date.now())}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: text ? `${notice}\n\n${text}` : notice,
            } as NormalizedMessage);
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            // Исключение — «Сейчас» не удалось: ход при этом ИДЁТ, сообщение
            // вернулось в очередь, и плашка «думает» должна остаться.
            if (msg.code !== 'SEND_NOW_UNAVAILABLE') {
              onSessionIdle?.(sid);
            }
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        case 'chat_run_started': {
          // Ход, заведённый сервером из очереди: нажатия человека не было, и
          // узнать о начале работы странице больше неоткуда.
          if (!sid) return;
          onSessionProcessing?.(sid);
          return;
        }

        // Очередь сообщений чата ведёт useSessionMessageQueue — в ленту это
        // событие не попадает.
        case 'chat_queue':
          return;

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // Flushes the live thinking accumulator into the store as a finished
      // `thinking` row, stamped with its measured duration. Called from both
      // `stream_end` (closes whichever block was streaming) and `complete`
      // (safety net for a turn that ends without content_block_stop reaching
      // here first) — a no-op when nothing thinking has accumulated.
      const flushThinking = () => {
        if (!sid) return;
        const timer = thinkingStreamTimerRef.current.get(sid);
        if (timer) {
          clearTimeout(timer);
          thinkingStreamTimerRef.current.delete(sid);
        }
        const accumulated = accumulatedThinkingRef.current.get(sid);
        if (accumulated) {
          const startedAt = thinkingStartedAtRef.current.get(sid);
          const durationSeconds = startedAt !== undefined
            ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
            : undefined;
          sessionStore.updateThinkingStreaming(sid, accumulated, provider);
          sessionStore.finalizeThinkingStreaming(sid, durationSeconds);
        }
        accumulatedThinkingRef.current.delete(sid);
        thinkingStartedAtRef.current.delete(sid);
      };

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'thinking_delta') {
        const text = (msg.content as string) || '';
        if (!sid) return;
        // Каждый delta размышления — прямое доказательство, что модель думает
        // прямо сейчас. Раньше индикатор об этом не знал и крутил выдуманные
        // слова по таймеру, из-за чего «думает» и «завис» выглядели одинаково.
        // Пустой delta тоже считается: сервер шлёт его в самом начале блока
        // размышления, когда текста ещё нет (он придёт пересказом в конце).
        onSessionProcessing?.(sid, { phase: 'thinking', detail: null, statusText: null, canInterrupt: true });
        if (!text) return;
        if (!accumulatedThinkingRef.current.has(sid)) {
          thinkingStartedAtRef.current.set(sid, Date.now());
        }
        accumulatedThinkingRef.current.set(sid, (accumulatedThinkingRef.current.get(sid) ?? '') + text);
        if (!thinkingStreamTimerRef.current.has(sid)) {
          thinkingStreamTimerRef.current.set(sid, window.setTimeout(() => {
            thinkingStreamTimerRef.current.delete(sid);
            const buffered = accumulatedThinkingRef.current.get(sid);
            if (buffered) {
              sessionStore.updateThinkingStreaming(sid, buffered, provider);
            }
          }, 100));
        }
        // Deltas are NOT appended to the transcript, for any session, active
        // or not. `appendRealtime` stores one message per call, so routing raw
        // deltas through it turned a single sentence into a column of
        // fragments ("Наш" / "ёл подозрительное место" / "самом деле."), each
        // with its own copy and read-aloud controls. The live row is what
        // shows streaming text; the finished message arrives on its own.
        return;
      }

      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text || !sid) return;
        onSessionProcessing?.(sid, { phase: 'writing', detail: null, statusText: null, canInterrupt: true });
        accumulatedStreamRef.current.set(sid, (accumulatedStreamRef.current.get(sid) ?? '') + text);
        if (!streamTimerRef.current.has(sid)) {
          streamTimerRef.current.set(sid, window.setTimeout(() => {
            streamTimerRef.current.delete(sid);
            const buffered = accumulatedStreamRef.current.get(sid);
            if (buffered) {
              sessionStore.updateStreaming(sid, buffered, provider);
            }
          }, 100));
        }
        // Not appended to the transcript — see the thinking_delta comment.
        return;
      }

      if (msg.kind === 'stream_end') {
        // This fires on every content_block_stop, whichever kind of block
        // just closed (thinking or text) — flush both accumulators, only
        // the one actually holding content does anything (see flushThinking
        // and the backend's stream_end comment for why that's safe).
        if (sid) {
          const timer = streamTimerRef.current.get(sid);
          if (timer) {
            clearTimeout(timer);
            streamTimerRef.current.delete(sid);
          }
          const buffered = accumulatedStreamRef.current.get(sid);
          if (buffered) {
            sessionStore.updateStreaming(sid, buffered, provider);
          }
          sessionStore.finalizeStreaming(sid);
          accumulatedStreamRef.current.delete(sid);
        }
        flushThinking();
        return;
      }

      // Этап работы без содержания — только подпись плашки, в ленту не идёт.
      if (msg.kind === 'run_phase') {
        if (sid && typeof msg.text === 'string') {
          onSessionProcessing?.(sid, {
            phase: msg.text as ActivityPhase,
            // detail — имя инструмента или число помощников (переживший перезапуск чат).
            detail: typeof msg.detail === 'string' ? msg.detail : null,
            statusText: null,
            canInterrupt: true,
          });
        }
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'run_phase'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- Живая фаза: инструменты и суб-агенты ---
      // Task — это запуск суб-агента, поэтому он считается отдельно: их может
      // идти несколько одновременно, и «работают 3 агента» — единственная
      // подпись, по которой видно, что происходит именно это.
      if (sid && msg.kind === 'tool_use') {
        const toolName = typeof msg.toolName === 'string' ? msg.toolName : '';
        const toolId = typeof msg.toolId === 'string' ? msg.toolId : '';
        if (isSubagentToolName(toolName) && toolId) {
          const running = activeAgentsRef.current.get(sid) ?? new Set<string>();
          running.add(toolId);
          activeAgentsRef.current.set(sid, running);
          // Несколько агентов сразу — считаем их, а не пересказываем, что
          // делает каждый: Егор 17.09.26 «если это не запущено другими
          // агентами, то это показывается» — под своими агентами прячем.
          onSessionProcessing?.(sid, { phase: 'agents', detail: String(running.size), statusText: null, canInterrupt: true });
        } else if (toolName) {
          // Живая плашка внизу — то же русское описание действия, что ИИ сам
          // пишет к вызову («Проверяю, дошла ли правка до сайта»), а не имя
          // инструмента («Bash»). Нет описания — старое поведение, имя
          // инструмента через фазу 'tool' в ActivityIndicator.
          const description = toolInputDescription((msg as { toolInput?: unknown }).toolInput);
          onSessionProcessing?.(sid, { phase: 'tool', detail: toolName, statusText: description, canInterrupt: true });
        }
      }

      if (sid && msg.kind === 'tool_result') {
        const toolId = typeof msg.toolId === 'string' ? msg.toolId : '';
        const running = activeAgentsRef.current.get(sid);
        if (running && toolId && running.delete(toolId)) {
          if (running.size > 0) {
            onSessionProcessing?.(sid, { phase: 'agents', detail: String(running.size), statusText: null, canInterrupt: true });
          } else {
            activeAgentsRef.current.delete(sid);
            onSessionProcessing?.(sid, { phase: 'reading', detail: null, statusText: null, canInterrupt: true });
          }
        } else if (!running || running.size === 0) {
          // Инструмент отработал, ответа модели ещё нет — это честное
          // «ждём», а не «думает».
          onSessionProcessing?.(sid, { phase: 'reading', detail: null, statusText: null, canInterrupt: true });
        }
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state
          if (sid) {
            const timer = streamTimerRef.current.get(sid);
            if (timer) {
              clearTimeout(timer);
              streamTimerRef.current.delete(sid);
            }
            const buffered = accumulatedStreamRef.current.get(sid);
            if (buffered) {
              sessionStore.updateStreaming(sid, buffered, provider);
              sessionStore.finalizeStreaming(sid);
            }
            accumulatedStreamRef.current.delete(sid);
          }
          flushThinking();

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            setTokenBudget(msg.tokenBudget as Record<string, unknown>);
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    thinkingStreamTimerRef,
    accumulatedThinkingRef,
    thinkingStartedAtRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}
