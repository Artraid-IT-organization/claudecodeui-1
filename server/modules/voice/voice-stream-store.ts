// Потоковая загрузка диктовки кусками (27.10.26): браузер по HTTP/1.1 не умеет
// стримить тело одного запроса, поэтому кусок записи улетает отдельным POST
// прямо во время диктовки. К моменту отпускания кнопки звук уже на сервере —
// остаётся только распознавание, как у WhisperKey через /audio/stream.
//
// Клиент шлёт куски строго последовательно (дожидается ответа каждого POST),
// поэтому серверу достаточно склейки по порядку прихода — seq не нужен.
// Склейка кусков webm/ogg от MediaRecorder(timeslice) — валидный контейнер:
// первый кусок несёт заголовок, остальные — продолжение потока.

type VoiceStreamSession = {
  mimeType: string;
  chunks: Buffer[];
  totalBytes: number;
  updatedAt: number;
};

export type VoiceStreamStore = {
  /** Добавляет кусок к сессии. Причина отказа — для кода ответа маршрута. */
  append(sid: string, chunk: Buffer, mimeType: string): 'ok' | 'bad-sid' | 'too-many' | 'too-big';
  /** Забирает собранную запись и удаляет сессию. */
  take(sid: string): { bytes: Buffer; mimeType: string } | undefined;
  /** Выбрасывает сессию (отмена записи на клиенте). */
  discard(sid: string): void;
  /** Число живых сессий — для тестов и диагностики. */
  size(): number;
  /** Останавливает таймер уборки — вызывают тесты. */
  stop(): void;
};

const SID_PATTERN = /^[A-Za-z0-9_-]{8,72}$/;

// Session cap is a safety net for abandoned recordings, not a load control:
// each user dictates in one tab at a time, so even 200 is far above real use.
const MAX_SESSIONS = 200;

/**
 * Хранилище кусков текущих диктовок: модуль voice, маршруты /stream-*.
 * Сессия живёт максимум ttlMs с последнего куска — уборка по таймеру,
 * брошенная запись не висит в памяти вечно.
 */
export function createVoiceStreamStore(options: {
  maxTotalBytes: number;
  ttlMs: number;
  sweepIntervalMs?: number;
  now?: () => number;
}): VoiceStreamStore {
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, VoiceStreamSession>();

  const sweep = () => {
    const cutoff = now() - options.ttlMs;
    for (const [sid, session] of sessions) {
      if (session.updatedAt < cutoff) sessions.delete(sid);
    }
  };

  const timer = setInterval(sweep, options.sweepIntervalMs ?? 60_000);
  timer.unref?.();

  return {
    append(sid, chunk, mimeType) {
      if (!SID_PATTERN.test(sid)) return 'bad-sid';
      let session = sessions.get(sid);
      if (!session) {
        if (sessions.size >= MAX_SESSIONS) return 'too-many';
        session = { mimeType, chunks: [], totalBytes: 0, updatedAt: now() };
        sessions.set(sid, session);
      }
      if (session.totalBytes + chunk.length > options.maxTotalBytes) return 'too-big';
      session.chunks.push(chunk);
      session.totalBytes += chunk.length;
      session.updatedAt = now();
      return 'ok';
    },

    take(sid) {
      const session = sessions.get(sid);
      if (!session) return undefined;
      sessions.delete(sid);
      return { bytes: Buffer.concat(session.chunks), mimeType: session.mimeType };
    },

    discard(sid) {
      sessions.delete(sid);
    },

    size() {
      return sessions.size;
    },

    stop() {
      clearInterval(timer);
    },
  };
}
