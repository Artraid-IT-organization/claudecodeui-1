/**
 * Очередь сообщений чата — на сервере, а не в браузере.
 *
 * Зачем. Раньше очередь лежала в localStorage вкладки, и отправлял её сам
 * браузер: чат освободился — страница заметила и послала следующее сообщение.
 * Пока сайт закрыт (телефон в кармане, вкладка выгружена, PWA не в фокусе),
 * замечать некому — Егор 20.09.26: «оно выложилось только тогда, когда я вошёл
 * в сайт; она никак не зависит от моего присутствия». Теперь очередь хранится
 * здесь, рядом с базой экземпляра, а отправляет её сервер по концу хода.
 *
 * Пережить перезапуск сайта очередь обязана: выкатка и перезагрузка — обычное
 * дело, а невысланное сообщение человека терять нельзя. Поэтому таблица, а не
 * память процесса.
 *
 * Порядок держим отдельным числом `position`, а не временем вставки: строки
 * переставляют стрелками в интерфейсе, и «сортировка по времени» это сломала
 * бы.
 */
import { getConnection } from '@/modules/database/connection.js';

/** Строка очереди в том виде, в каком её отправляет и показывает сервер. */
export type StoredQueuedChatMessage = {
  /**
   * Номер сообщения, придуманный страницей (`clientMessageId`). Тот же номер
   * лежит в журнале принятых отправок, поэтому повторная доставка того же
   * сообщения не ставит его в очередь дважды.
   */
  id: string;
  sessionId: string;
  /**
   * Чей это запуск. Нужен на отправке: на общем сайте у каждого свой каталог
   * настроек Claude и свой ключ, и запустить сообщение «от никого» нельзя.
   */
  userId: string | null;
  content: string;
  /** Снимок настроек составителя на момент постановки: модель, режим прав, вложения. */
  options: Record<string, unknown>;
  createdAt: string;
};

type QueueRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  content: string;
  options_json: string;
  position: number;
  created_at: string;
};

let readyConnection: unknown = null;

function ensureTable(): void {
  const db = getConnection();
  if (readyConnection === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_message_queue (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      content TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_chat_message_queue_session
      ON chat_message_queue(session_id, position, created_at);
  `);
  readyConnection = db;
}

function parseOptions(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toQueuedMessage(row: QueueRow): StoredQueuedChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    content: row.content,
    options: parseOptions(row.options_json),
    createdAt: row.created_at,
  };
}

/**
 * chatMessageQueueDb: очередь сообщений чата.
 *
 * Используется модулем websocket (chat-queue.service) — он единственный, кто
 * ставит в очередь, снимает с неё и рассылает её вид страницам.
 */
export const chatMessageQueueDb = {
  list(sessionId: string): StoredQueuedChatMessage[] {
    ensureTable();
    const rows = getConnection()
      .prepare(
        `SELECT * FROM chat_message_queue WHERE session_id = ?
         ORDER BY position ASC, created_at ASC, id ASC`,
      )
      .all(sessionId) as QueueRow[];
    return rows.map(toQueuedMessage);
  },

  has(id: string): boolean {
    ensureTable();
    const row = getConnection()
      .prepare('SELECT id FROM chat_message_queue WHERE id = ?')
      .get(id) as { id: string } | undefined;
    return Boolean(row);
  },

  /**
   * Ставит сообщение в конец очереди. Повтор с тем же номером игнорируется —
   * страница досылает сообщение, пока не получит расписку, и копия не должна
   * встать в очередь второй раз.
   */
  append(message: Omit<StoredQueuedChatMessage, 'createdAt'>): void {
    ensureTable();
    const db = getConnection();
    const next = db
      .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM chat_message_queue WHERE session_id = ?')
      .get(message.sessionId) as { next: number };
    db.prepare(
      `INSERT OR IGNORE INTO chat_message_queue (id, session_id, user_id, content, options_json, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.sessionId,
      message.userId === null ? null : String(message.userId),
      message.content,
      JSON.stringify(message.options ?? {}),
      next.next,
    );
  },

  /**
   * Возвращает снятое сообщение в НАЧАЛО очереди. Нужно, когда запуск не
   * удалось завести (занят предел одновременных чатов, чат уже работает):
   * сообщение не теряется, а ждёт следующего освобождения.
   */
  pushFront(message: StoredQueuedChatMessage): void {
    ensureTable();
    const db = getConnection();
    const first = db
      .prepare('SELECT COALESCE(MIN(position), 0) - 1 AS prev FROM chat_message_queue WHERE session_id = ?')
      .get(message.sessionId) as { prev: number };
    db.prepare(
      `INSERT OR REPLACE INTO chat_message_queue (id, session_id, user_id, content, options_json, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.sessionId,
      message.userId === null ? null : String(message.userId),
      message.content,
      JSON.stringify(message.options ?? {}),
      first.prev,
      message.createdAt,
    );
  },

  /**
   * Снимает первое сообщение очереди и тут же удаляет его — «талон»: кто снял,
   * тот и отправляет. Удаление и чтение в одной сделке, поэтому два
   * одновременных конца хода не заберут одну строку дважды.
   */
  takeFirst(sessionId: string): StoredQueuedChatMessage | null {
    ensureTable();
    const db = getConnection();
    const take = db.transaction((session: string) => {
      const row = db
        .prepare(
          `SELECT * FROM chat_message_queue WHERE session_id = ?
           ORDER BY position ASC, created_at ASC, id ASC LIMIT 1`,
        )
        .get(session) as QueueRow | undefined;
      if (!row) {
        return null;
      }
      db.prepare('DELETE FROM chat_message_queue WHERE id = ?').run(row.id);
      return row;
    });
    const row = take(sessionId) as QueueRow | null;
    return row ? toQueuedMessage(row) : null;
  },

  remove(sessionId: string, id: string): void {
    ensureTable();
    getConnection()
      .prepare('DELETE FROM chat_message_queue WHERE session_id = ? AND id = ?')
      .run(sessionId, id);
  },

  clear(sessionId: string): void {
    ensureTable();
    getConnection().prepare('DELETE FROM chat_message_queue WHERE session_id = ?').run(sessionId);
  },

  /** Переставляет очередь в присланный порядок; не названные строки остаются в хвосте. */
  reorder(sessionId: string, orderedIds: string[]): void {
    ensureTable();
    const db = getConnection();
    const apply = db.transaction((session: string, ids: string[]) => {
      const update = db.prepare('UPDATE chat_message_queue SET position = ? WHERE session_id = ? AND id = ?');
      ids.forEach((id, index) => update.run(index + 1, session, id));
      // Строки, которых в присланном порядке нет (добавились с другого
      // устройства), уходят за названные, сохраняя свой относительный порядок.
      db.prepare(
        `UPDATE chat_message_queue SET position = position + ?
         WHERE session_id = ? AND id NOT IN (${ids.map(() => '?').join(',') || "''"})`,
      ).run(ids.length + 1, session, ...ids);
    });
    apply(sessionId, orderedIds);
  },

  /** Чаты, у которых что-то стоит в очереди. По ним идёт обход после каждого конца хода. */
  sessionsWithQueue(): string[] {
    ensureTable();
    const rows = getConnection()
      .prepare('SELECT DISTINCT session_id FROM chat_message_queue')
      .all() as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  },
};
