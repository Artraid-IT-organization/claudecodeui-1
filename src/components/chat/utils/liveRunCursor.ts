/**
 * Какую работу (запуск ИИ) вкладка видела последней в каждом чате.
 *
 * Номер события `seq` у каждой работы свой и начинается с 1, а вкладка хранит
 * самый большой увиденный номер на чат и отбрасывает всё, что не больше его —
 * так она защищается от повторной доставки. Без метки работы это ломалось:
 * после долгой работы вкладка помнила, например, 2000, новая работа приходила
 * с номерами 1, 2, 3… и выбрасывалась целиком — вместе с сигналом «работает».
 * Егор 13.09.26: «не вижу плашки что ИИ думает, хотя на самом деле размышление
 * идёт».
 *
 * Метку ставит сервер (`runStartedAt`). Увидев новую — счёт по чату начинается
 * заново.
 */
const knownRuns = new Map<string, number>();

export function knownRunStartedAt(sessionId: string): number | undefined {
  return knownRuns.get(sessionId);
}

/**
 * Запоминает работу события. Если она новая — сбрасывает счётчик номеров
 * этого чата, чтобы её события не приняли за уже виденные. Возвращает true,
 * если счётчик сброшен.
 */
export function noteRun(
  sessionId: string,
  runStartedAt: unknown,
  lastSeqBySession: Map<string, number>,
): boolean {
  if (typeof runStartedAt !== 'number' || !Number.isFinite(runStartedAt)) {
    return false;
  }
  if (knownRuns.get(sessionId) === runStartedAt) {
    return false;
  }
  knownRuns.set(sessionId, runStartedAt);
  lastSeqBySession.set(sessionId, 0);
  return true;
}
