/**
 * Оценки формата ответов ассистента — «палец вверх / палец вниз» в ленте чата.
 *
 * Порт контракта референса ~/response-format-memory (19.10.26): одна оценка на
 * сообщение, PUT идемпотентен — повторное нажатие переписывает запись и
 * увеличивает revision, а не создаёт дубль. Уникальный первичный ключ по
 * message_id делает upsert атомарным даже при повторной доставке клика.
 *
 * В отличие от референса сообщения здесь не хранятся в базе (транскрипты —
 * JSONL провайдера), поэтому domain и format_hash денормализованы прямо в
 * запись оценки: их считает клиент по тексту ответа и присылает вместе с
 * направлением.
 *
 * Используется модулем message-feedback (роуты /api/messages/*). Таблица
 * создаётся лениво при первом обращении, как в open-tabs.
 */
import { getConnection } from '@/modules/database/connection.js';

export type MessageFeedbackRow = {
  messageId: string;
  sessionId: string | null;
  direction: number;
  category: string | null;
  comment: string | null;
  domain: string | null;
  formatHash: string | null;
  revision: number;
};

export type MessageFeedbackUpsert = {
  messageId: string;
  sessionId: string | null;
  userId: number | null;
  direction: number;
  category: string | null;
  comment: string | null;
  domain: string | null;
  formatHash: string | null;
};

let readyConnection: unknown = null;

function ensureTable(): void {
  const db = getConnection();
  if (readyConnection === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_feedback (
      message_id TEXT PRIMARY KEY,
      session_id TEXT,
      user_id INTEGER,
      direction INTEGER NOT NULL,
      category TEXT,
      comment TEXT,
      domain TEXT,
      format_hash TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS ix_message_feedback_session
      ON message_feedback (session_id);
  `);
  readyConnection = db;
}

type RawRow = {
  message_id: string;
  session_id: string | null;
  direction: number;
  category: string | null;
  comment: string | null;
  domain: string | null;
  format_hash: string | null;
  revision: number;
};

const toRow = (raw: RawRow): MessageFeedbackRow => ({
  messageId: raw.message_id,
  sessionId: raw.session_id,
  direction: raw.direction,
  category: raw.category,
  comment: raw.comment,
  domain: raw.domain,
  formatHash: raw.format_hash,
  revision: raw.revision,
});

export const messageFeedbackDb = {
  /**
   * Создаёт или перезаписывает единственную оценку сообщения. Повтор того же
   * направления тоже считается новой ревизией — по revision видно частоту
   * перекликиваний.
   */
  upsert(input: MessageFeedbackUpsert): MessageFeedbackRow {
    ensureTable();
    const db = getConnection();
    db.prepare(
      `INSERT INTO message_feedback
         (message_id, session_id, user_id, direction, category, comment, domain, format_hash, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(message_id) DO UPDATE SET
         session_id = COALESCE(excluded.session_id, message_feedback.session_id),
         user_id = excluded.user_id,
         direction = excluded.direction,
         category = excluded.category,
         comment = excluded.comment,
         -- domain/format_hash — свойства сообщения, а не голоса: повторная
         -- оценка без них не должна стирать уже записанный слепок формы.
         domain = COALESCE(excluded.domain, message_feedback.domain),
         format_hash = COALESCE(excluded.format_hash, message_feedback.format_hash),
         revision = message_feedback.revision + 1,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      input.messageId,
      input.sessionId,
      input.userId,
      input.direction,
      input.category,
      input.comment,
      input.domain,
      input.formatHash
    );
    const row = db
      .prepare('SELECT * FROM message_feedback WHERE message_id = ?')
      .get(input.messageId) as RawRow | undefined;
    if (!row) throw new Error('оценка не записалась');
    return toRow(row);
  },

  /**
   * Удаляет оценку сообщения — отмена голоса повторным кликом на активную кнопку.
   * Возвращает true, если запись существовала и была удалена.
   */
  remove(messageId: string, userId: number): boolean {
    ensureTable();
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM message_feedback WHERE message_id = ? AND user_id = ?')
      .run(messageId, userId);
    return result.changes > 0;
  },

  /**
   * Все оценки сессии пользователя — для восстановления состояния кнопок после
   * перезагрузки страницы. Чужую сессию не отдаёт: фильтр по user_id.
   */
  listBySession(sessionId: string, userId: number): MessageFeedbackRow[] {
    ensureTable();
    const db = getConnection();
    const rows = db
      .prepare(
        'SELECT * FROM message_feedback WHERE session_id = ? AND user_id = ?'
      )
      .all(sessionId, userId) as RawRow[];
    return rows.map(toRow);
  },
};
