import type { RealtimeClientConnection } from '@/shared/types.js';
import { isPlatformOwnerWebUser, OPEN_REGISTRATION } from '@/shared/utils.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

/**
 * Connection → authenticated web user id, recorded on chat connect.
 *
 * Broadcast paths use this to decide which realtime events a connection may
 * receive — Devin's credentials and session store are machine-global, so on
 * multi-tenant instances its sessions must not leak (sidebar entries, queue
 * contents, run state) into a guest's socket.
 */
export const clientUserIds = new WeakMap<RealtimeClientConnection, string | number | null>();

import { sessionsDb } from '@/modules/database/index.js';

/**
 * Whether this connection may receive realtime events of `provider`.
 * Devin-чаты — собственность инициатора (Connection Layer): событие с
 * sessionId идёт только его сокетам (+ владельцу площадки); без sessionId
 * (наследие) — только владельцу. Остальные провайдеры видят все — как раньше.
 */
export function canReceiveProviderEvents(
  client: RealtimeClientConnection,
  provider: string | null | undefined,
  sessionId?: string | null,
): boolean {
  if (provider !== 'devin' || !OPEN_REGISTRATION) {
    return true;
  }
  const userId = clientUserIds.get(client);
  const numericUserId = userId === null || userId === undefined ? NaN : Number(userId);
  if (Number.isFinite(numericUserId) && isPlatformOwnerWebUser(numericUserId)) {
    return true;
  }
  if (!sessionId) {
    return false;
  }
  // В devin-событиях sessionId — чаще всего провайдерский (devinSessionId),
  // строку находим по обоим ключам.
  const row = sessionsDb.getSessionById(sessionId)
    ?? sessionsDb.getSessionByProviderSessionId(sessionId);
  return row?.initiated_by_user_id != null
    && Number(row.initiated_by_user_id) === numericUserId;
}

/**
 * Broadcast one JSON payload to every connected client allowed to see
 * `provider` traffic. `sessionId` вытаскивается из payload, если вызывающий
 * его явно не передал — нужен для per-user фильтрации devin-событий.
 */
export function broadcastRealtimeEvent(payload: string, provider?: string | null, sessionId?: string | null): void {
  let sid = sessionId ?? null;
  if (provider === 'devin' && sid == null) {
    try {
      const parsed = JSON.parse(payload) as { sessionId?: unknown; newSessionId?: unknown };
      sid = typeof parsed.sessionId === 'string' ? parsed.sessionId
        : typeof parsed.newSessionId === 'string' ? parsed.newSessionId : null;
    } catch {
      sid = null;
    }
  }
  for (const client of connectedClients) {
    if (client.readyState === WS_OPEN_STATE && canReceiveProviderEvents(client, provider, sid)) {
      client.send(payload);
    }
  }
}
