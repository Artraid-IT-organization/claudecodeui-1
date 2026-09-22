/**
 * `false` — отложено (чат не на экране), догрузится при показе; `'failed'` —
 * запрос не удался (сеть, срок), догрузка повторится сама по `retryDelaysMs`.
 */
export type MessageHistoryRefreshExecutor = (sessionId: string) => Promise<boolean | 'failed' | void>;
export type CanRefreshMessageHistory = (sessionId: string) => boolean;

export type MessageHistoryRefreshCoordinator = {
  request: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  flushPending: (sessionId: string) => Promise<void>;
  discardPending: (sessionId: string) => void;
  hasPending: (sessionId: string) => boolean;
};

/**
 * Coalesces automatic persisted-history refresh signals without owning any
 * React state. Hidden sessions remain dirty until they become visible; active
 * bursts collapse into the current request plus at most one trailing request.
 */
// Паузы повторов после неудачи. iPhone, вернувшись из фона, шлёт первые
// запросы в мёртвое соединение: они висят до срока и падают, а сокет к тому
// времени уже переподключён. Без повтора открытый чат оставался застывшим на
// моменте ухода в фон, хотя ход давно закончился (22.09.26, снимок Егора).
export const DEFAULT_REFRESH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

export function createMessageHistoryRefreshCoordinator(
  executeRefresh: MessageHistoryRefreshExecutor,
  canRefreshNow: CanRefreshMessageHistory,
  retryDelaysMs: readonly number[] = DEFAULT_REFRESH_RETRY_DELAYS_MS,
): MessageHistoryRefreshCoordinator {
  const pendingSessions = new Set<string>();
  const inFlightBySession = new Map<string, Promise<void>>();
  const failuresBySession = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const scheduleRetry = (sessionId: string) => {
    const failures = (failuresBySession.get(sessionId) ?? 0) + 1;
    failuresBySession.set(sessionId, failures);
    const delay = retryDelaysMs[failures - 1];
    // Попытки кончились — чат остаётся помеченным: догрузится при следующем
    // показе или сигнале, а не будет опрашивать сервер бесконечно.
    if (delay === undefined || retryTimers.has(sessionId)) return;
    retryTimers.set(sessionId, setTimeout(() => {
      retryTimers.delete(sessionId);
      if (pendingSessions.has(sessionId) && canRefreshNow(sessionId)) void drain(sessionId);
    }, delay));
  };

  const drain = (sessionId: string): Promise<void> => {
    const existing = inFlightBySession.get(sessionId);
    if (existing) {
      pendingSessions.add(sessionId);
      return existing;
    }

    const request = (async () => {
      try {
        do {
          pendingSessions.delete(sessionId);
          const completed = await executeRefresh(sessionId);
          if (completed === 'failed') {
            pendingSessions.add(sessionId);
            scheduleRetry(sessionId);
            break;
          }
          failuresBySession.delete(sessionId);
          if (completed === false) {
            pendingSessions.add(sessionId);
            break;
          }
        } while (pendingSessions.has(sessionId) && canRefreshNow(sessionId));
      } catch {
        pendingSessions.add(sessionId);
        scheduleRetry(sessionId);
      }
    })().finally(() => {
      inFlightBySession.delete(sessionId);
    });

    inFlightBySession.set(sessionId, request);
    return request;
  };

  return {
    request(sessionId: string, allowNetwork = true): Promise<void> {
      // Новый сигнал — новая серия попыток: прежние неудачи не должны
      // съедать повторы у свежего возврата на экран.
      failuresBySession.delete(sessionId);
      if (!allowNetwork || !canRefreshNow(sessionId)) {
        pendingSessions.add(sessionId);
        return Promise.resolve();
      }
      return drain(sessionId);
    },

    flushPending(sessionId: string): Promise<void> {
      if (!pendingSessions.has(sessionId) || !canRefreshNow(sessionId)) {
        return Promise.resolve();
      }
      return drain(sessionId);
    },

    discardPending(sessionId: string): void {
      pendingSessions.delete(sessionId);
      failuresBySession.delete(sessionId);
      const timer = retryTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      retryTimers.delete(sessionId);
    },

    hasPending(sessionId: string): boolean {
      return pendingSessions.has(sessionId);
    },
  };
}
