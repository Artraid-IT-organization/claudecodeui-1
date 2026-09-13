/**
 * Чаты, работу которых ведёт агент, переживший перезапуск сайта.
 *
 * У такого чата нет живого потока событий: вкладка узнаёт о новых шагах только
 * из сигнала «переписка изменилась» (session_upserted с detachedRun). Окно чата
 * при этом считает чат работающим и по умолчанию не перечитывает переписку,
 * чтобы не ломать живой поток, — поэтому шаги такого чата появлялись разом, когда
 * он закончит. Список нужен, чтобы окно чата знало: живого потока нет, перечитывать
 * можно и во время работы.
 */
const detachedSessionIds = new Set<string>();

export function markDetachedRun(sessionId: string, isDetached: boolean): void {
  if (!sessionId) return;
  if (isDetached) {
    detachedSessionIds.add(sessionId);
  } else {
    detachedSessionIds.delete(sessionId);
  }
}

export function isDetachedRun(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId) && detachedSessionIds.has(sessionId as string);
}
