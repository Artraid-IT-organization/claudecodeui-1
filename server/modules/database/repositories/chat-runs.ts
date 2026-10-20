/**
 * Журнал ходов чата — на диске, а не в памяти сервера.
 *
 * Зачем. Статус хода жил только в оперативной памяти веб-сервера
 * (chat-run-registry). Смерть процесса (перезапуск при выкатке, OOM,
 * авария) стирала сам факт «ход был» — а вместе с ним и его конец:
 * человек открывал чат и видел замершее «размышление» без ошибки и без
 * результата (14.10.26, «Аренда Москвы»: ход упал на лимите модели в
 * 22:02, а Егор полтора часа смотрел на мёртвый экран).
 *
 * Теперь каждый ход пишет строку: начало, якорь доставки prompt,
 * неотправленное сообщение (для возврата в очередь после аварии) и
 * терминальный исход — успех, ошибка, остановка человеком или обрыв.
 * Подпись вкладки (`chat_subscribed.lastRun`) и сверка при старте
 * сервера читают отсюда: ход никогда не остаётся без видимого конца.
 *
 * Пишем редко: вставка при старте, обновление при якоре и при конце.
 * Поток дельт таблицу не трогает — `last_event_at` нужен только для
 * точек «жив ли он до сих пор», а это память реестра.
 */
import { getConnection } from '@/modules/database/connection.js';

/** Исход хода: всё, кроме `running`, — терминальное состояние. */
export type ChatRunStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted';

/** Сообщение, принятое от человека и ещё не доехавшее до агента. */
export type StoredRunPendingMessage = {
  id: string;
  userId: string | null;
  content: string;
  options: Record<string, unknown>;
};

export type StoredChatRun = {
  runId: string;
  sessionId: string;
  provider: string | null;
  status: ChatRunStatus;
  /** Человекочитаемая причина терминального неуспеха; null при успехе/работе. */
  error: string | null;
  promptAnchored: boolean;
  pending: StoredRunPendingMessage | null;
  startedAt: string;
  finishedAt: string | null;
};

type ChatRunRow = {
  run_id: string;
  session_id: string;
  provider: string | null;
  status: string;
  error: string | null;
  prompt_anchored: number;
  pending_json: string | null;
  started_at: string;
  finished_at: string | null;
};

let readyConnection: unknown = null;

function ensureTable(): void {
  const db = getConnection();
  if (readyConnection === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      provider TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      prompt_anchored INTEGER NOT NULL DEFAULT 0,
      pending_json TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_chat_runs_session
      ON chat_runs(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_chat_runs_status
      ON chat_runs(status);
  `);
  readyConnection = db;
}

function toStoredRun(row: ChatRunRow): StoredChatRun {
  let pending: StoredRunPendingMessage | null = null;
  if (row.pending_json) {
    try {
      const parsed = JSON.parse(row.pending_json) as unknown;
      if (parsed && typeof parsed === 'object') {
        pending = parsed as StoredRunPendingMessage;
      }
    } catch {
      pending = null;
    }
  }
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    provider: row.provider,
    status: (row.status as ChatRunStatus) || 'running',
    error: row.error,
    promptAnchored: row.prompt_anchored === 1,
    pending,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * chatRunsDb: журнал ходов.
 *
 * Пишет только модуль websocket (chat-run-registry.service) и сверка при
 * старте сервера в server/index.ts. Читает `chat_subscribed` — вкладке
 * нужен последний исход хода, чтобы показать плашку вместо мёртвой тишины.
 */
export const chatRunsDb = {
  /** Регистрация начала хода; `pending` — принятое сообщение до якоря. */
  begin(run: {
    runId: string;
    sessionId: string;
    provider: string | null;
    pending: StoredRunPendingMessage | null;
  }): void {
    ensureTable();
    getConnection()
      .prepare(
        `INSERT OR REPLACE INTO chat_runs
         (run_id, session_id, provider, status, error, prompt_anchored, pending_json, started_at)
         VALUES (?, ?, ?, 'running', NULL, 0, ?, ?)`,
      )
      .run(
        run.runId,
        run.sessionId,
        run.provider,
        run.pending ? JSON.stringify(run.pending) : null,
        new Date().toISOString(),
      );
  },

  /** prompt доехал до выживающего процесса: сообщение уже не наше, а у агента. */
  markAnchored(runId: string): void {
    ensureTable();
    getConnection()
      .prepare('UPDATE chat_runs SET prompt_anchored = 1, pending_json = NULL WHERE run_id = ?')
      .run(runId);
  },

  /** Сообщение ушло обратно в очередь (гашение сервера, возврат в finally). */
  clearPending(runId: string): void {
    ensureTable();
    getConnection()
      .prepare('UPDATE chat_runs SET pending_json = NULL WHERE run_id = ?')
      .run(runId);
  },

  /** Терминальная запись: ход доехал до конца — с результатом или с причиной. */
  finish(runId: string, outcome: { status: Exclude<ChatRunStatus, 'running'>; error?: string | null }): void {
    ensureTable();
    getConnection()
      .prepare(
        `UPDATE chat_runs SET status = ?, error = ?, finished_at = ?, pending_json = NULL
         WHERE run_id = ?`,
      )
      .run(outcome.status, outcome.error ?? null, new Date().toISOString(), runId);
  },

  /** Все ходы, ещё считающиеся идущими, — для сверки при старте сервера. */
  listRunning(): StoredChatRun[] {
    ensureTable();
    const rows = getConnection()
      .prepare(`SELECT * FROM chat_runs WHERE status = 'running'`)
      .all() as ChatRunRow[];
    return rows.map(toStoredRun);
  },

  /**
   * Последний ЗАВЕРШЁННЫЙ ход чата — вкладке, чтобы показать человеку
   * «чем всё кончилось», когда лента молчит.
   */
  latestFinishedForSession(sessionId: string): StoredChatRun | null {
    ensureTable();
    const row = getConnection()
      .prepare(
        `SELECT * FROM chat_runs WHERE session_id = ? AND status != 'running'
         ORDER BY finished_at DESC, started_at DESC LIMIT 1`,
      )
      .get(sessionId) as ChatRunRow | undefined;
    return row ? toStoredRun(row) : null;
  },

  /** Старший по времени незавершённый ход чата — сверке при старте. */
  runningForSession(sessionId: string): StoredChatRun | null {
    ensureTable();
    const row = getConnection()
      .prepare(
        `SELECT * FROM chat_runs WHERE session_id = ? AND status = 'running'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(sessionId) as ChatRunRow | undefined;
    return row ? toStoredRun(row) : null;
  },

  /**
   * Закрыть незавершённую строку чата снаружи реестра — например, когда
   * ход вёл переживший перезапуск процесс и закончился уже без нас.
   */
  finishRunningForSession(sessionId: string, outcome: { status: Exclude<ChatRunStatus, 'running'>; error?: string | null }): void {
    ensureTable();
    getConnection()
      .prepare(
        `UPDATE chat_runs SET status = ?, error = ?, finished_at = ?, pending_json = NULL
         WHERE session_id = ? AND status = 'running'`,
      )
      .run(outcome.status, outcome.error ?? null, new Date().toISOString(), sessionId);
  },

  /** Уборка истории: строки старше N дней. Хранятся ради «а что тогда было». */
  pruneOlderThan(days: number): number {
    ensureTable();
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = getConnection()
      .prepare(`DELETE FROM chat_runs WHERE started_at < ? AND status != 'running'`)
      .run(cutoff);
    return result.changes;
  },
};
