import { useEffect, useRef } from 'react';

import { shiftQueuedMessage } from '../components/chat/utils/chatStorage';

import type { MarkSessionProcessing, SessionActivityMap } from './useSessionProtection';

interface UseQueuedMessageAutoSendArgs {
  processingSessions: SessionActivityMap;
  /**
   * The session currently open in the chat view. Its queued draft is owned by
   * the composer (which also handles file attachments and slash commands),
   * so this hook never touches it.
   */
  activeSessionId: string | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  markSessionProcessing: MarkSessionProcessing;
}

/**
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists the whole queue (text + send options snapshotted at
 * queue time) under `queued_messages_<sessionId>`. When a session's run leaves
 * the processing map — its previous response completed — this hook sends that
 * session's FIRST queued message immediately instead of waiting for the user
 * to open the session again; the rest stay in line and go out the same way as
 * each run ends. Removing the item from storage before sending is the claim
 * that keeps the composer's own flush from double-sending.
 */
export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionId,
  sendMessage,
  markSessionProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const prevProcessingRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const prev = prevProcessingRef.current;
    const current = new Set(processingSessions.keys());
    prevProcessingRef.current = current;

    for (const sessionId of prev) {
      if (current.has(sessionId) || sessionId === activeSessionId) {
        continue;
      }

      // Снимаем с очереди ОДНО, первое: остальные дождутся своей очереди —
      // этот же эффект сработает ещё раз, когда закончится запущенный ход.
      // Снятие до отправки — талон, который не даёт составителю послать то же
      // самое второй раз.
      const queued = shiftQueuedMessage(sessionId);
      if (!queued) {
        continue;
      }

      // Проверки «сокет открыт» здесь больше нет: на iPhone она врёт в обе
      // стороны, а chat.send теперь не выбрасывается — WebSocketContext держит
      // его в очереди до расписки сервера и досылает сам (contexts/chatOutbox.ts).
      sendMessage({
        type: 'chat.send',
        sessionId,
        content: queued.content,
        options: { ...(queued.options ?? {}), attachments: queued.attachments ?? queued.images ?? [] },
      });
      markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
    }
  }, [processingSessions, activeSessionId, sendMessage, markSessionProcessing]);
}
