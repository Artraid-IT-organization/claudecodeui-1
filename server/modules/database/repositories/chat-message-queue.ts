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
 * Модель захвата (14.10.26 — потеря трёх сообщений в чате 13fa2cd9).
 * Строка НЕ удаляется, пока ход её не съест: обход помечает её `claimed_at`
 * («захвачена»), а удаляет только `markDelivered` — в точке, где рантайм
 * подтверждает, что prompt записан выживающему процессу (promptAnchored).
 * Падение на любой ступени до этого возвращает захват — сообщение снова видно
 * и ждёт следующего прохода; смерть процесса между захватом и якорем закрывает
 * `releaseAllClaims` на подъёме. После MAX попыток строка уходит в
 * `delivery_state='failed'` — видимая в доке ошибка, а не тихая пропажа.
 *
 * Прямая отправка («чат свободен, поехали сразу») пишет такую же строку
 * (`appendClaimedFront`): и ветка очереди, и ветка «сразу» проходят один и тот
 * же путь «не потерять до якоря».
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
  /**
   * Захват строки (мс эпохи) — её сейчас везёт ход. Захваченные строки из
   * дока очереди прячутся: «уходит» уже видно по пузырю/плашке работы.
   */
  claimedAt: number | null;
  /**
   * `queued` — ждёт своего запуска; `failed` — сервер сдался после всех
   * попыток и честно показал ошибку. Строка при этом остаётся в базе — её
   * может перечитать и переслать человек.
   */
  state: 'queued' | 'failed';
  /** Почему помечена `failed` — показывается человеку под строкой в доке. */
  lastError: string | null;
};

type QueueRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  content: string;
  options_json: string;
  position: number;
  created_at: string;
  claimed_at: number | null;
  delivery_state: string;
  last_error: string | null;
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      claimed_at INTEGER,
      delivery_state TEXT NOT NULL DEFAULT 'queued',
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_message_queue_session
      ON chat_message_queue(session_id, position, created_at);
  `);
  // Таблица живёт с 20.09.26 — у баз на бою новых колонок нет. Докидываем их
  // обычным ALTER; «такая колонка уже есть» при повторном поднятии — не ошибка.
  const columns = new Set(
    (db.prepare('PRAGMA table_info(chat_message_queue)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!columns.has('claimed_at')) {
    db.exec('ALTER TABLE chat_message_queue ADD COLUMN claimed_at INTEGER');
  }
  if (!columns.has('delivery_state')) {
    db.exec("ALTER TABLE chat_message_queue ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'queued'");
  }
  if (!columns.has('last_error')) {
    db.exec('ALTER TABLE chat_message_queue ADD COLUMN last_error TEXT');
  }
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
    claimedAt: row.claimed_at ?? null,
    state: row.delivery_state === 'failed' ? 'failed' : 'queued',
    lastError: row.last_error ?? null,
  };
}

/**
 * chatMessageQueueDb: очередь сообщений чата.
 *
 * Используется модулем websocket (chat-queue.service) — он единственный, кто
 * ставит в очередь, захватывает строки и рассылает её вид страницам; реестр
 * ходов (chat-run-registry.service) зовёт только `markDelivered` на якоре и
 * `releaseClaim`/`markFailed` на неудаче.
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
  append(message: Omit<StoredQueuedChatMessage, 'createdAt' | 'claimedAt' | 'state' | 'lastError'>): void {
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
   * Прямая отправка: строка встаёт в КОНЕЦ очереди сразу захваченной —
   * write-ahead для ветки «чат свободен, запуск пошёл». Если запуск падёт до
   * якоря, ход вернёт захват, и сообщение доедет обычным обходом В СВОЁМ
   * ПОРЯДКЕ (оно было последним по времени — значит, в хвост); доедет —
   * `markDelivered` сотрёт её при передаче prompt. `OR IGNORE`: повтор
   * досылки с тем же номером строки не дублирует.
   */
  appendClaimedLast(
    message: Omit<StoredQueuedChatMessage, 'createdAt' | 'claimedAt' | 'state' | 'lastError'>,
  ): void {
    ensureTable();
    const db = getConnection();
    const next = db
      .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM chat_message_queue WHERE session_id = ?')
      .get(message.sessionId) as { next: number };
    db.prepare(
      `INSERT OR IGNORE INTO chat_message_queue
         (id, session_id, user_id, content, options_json, position, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.sessionId,
      message.userId === null ? null : String(message.userId),
      message.content,
      JSON.stringify(message.options ?? {}),
      next.next,
      Date.now(),
    );
  },

  /**
   * Вставляет строку в НАЧАЛО очереди свободной (без захвата): возврат
   * сообщения, чья исходная строка не дошла до базы, или «Сейчас» в занятом
   * чате. Используется только как запасной путь — обычная доставка живёт на
   * захвате, не на перезаписи.
   */
  insertFront(message: Omit<StoredQueuedChatMessage, 'claimedAt' | 'state' | 'lastError'>): void {
    ensureTable();
    const db = getConnection();
    const first = db
      .prepare('SELECT COALESCE(MIN(position), 0) - 1 AS prev FROM chat_message_queue WHERE session_id = ?')
      .get(message.sessionId) as { prev: number };
    db.prepare(
      `INSERT OR REPLACE INTO chat_message_queue
         (id, session_id, user_id, content, options_json, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.sessionId,
      message.userId === null ? null : String(message.userId),
      message.content,
      JSON.stringify(message.options ?? {}),
      first.prev,
      message.createdAt || new Date().toISOString(),
    );
  },

  /**
   * Захватывает конкретную строку (кнопка «Сейчас» у сообщения в очереди).
   * `false` — её уже кто-то везёт или её нет: второй захват той же строки
   * невозможен.
   */
  claim(id: string): boolean {
    ensureTable();
    const result = getConnection()
      .prepare(
        `UPDATE chat_message_queue SET claimed_at = ?
         WHERE id = ? AND claimed_at IS NULL AND delivery_state = 'queued'`,
      )
      .run(Date.now(), id);
    return result.changes > 0;
  },

  /**
   * Первая НЕзахваченная строка очереди БЕЗ захвата — посмотреть условия
   * отправки до решения её везти (например, паузу `__notBefore` после
   * неудачи доставки). Захват делает `claim(id)` — он атомарен сам по себе,
   * гонка между просмотром и захватом проигрывается безболезненно.
   */
  peekFirst(sessionId: string): StoredQueuedChatMessage | null {
    ensureTable();
    const row = getConnection()
      .prepare(
        `SELECT * FROM chat_message_queue
         WHERE session_id = ? AND claimed_at IS NULL AND delivery_state = 'queued'
         ORDER BY position ASC, created_at ASC, id ASC LIMIT 1`,
      )
      .get(sessionId) as QueueRow | undefined;
    return row ? toQueuedMessage(row) : null;
  },

  /**
   * Захватывает первую НЕзахваченную строку очереди — «талон»: кто захватил,
   * тот и отправляет. Захват и выбор идут одной сделкой, два одновременных
   * конца хода одну строку не заберут дважды. Строка остаётся в таблице:
   * умирает она только через `markDelivered` на якоре, `markFailed` после
   * всех попыток или явной правкой человека.
   */
  claimFirst(sessionId: string): StoredQueuedChatMessage | null {
    ensureTable();
    const db = getConnection();
    const claimedAt = Date.now();
    const claim = db.transaction((session: string) => {
      const row = db
        .prepare(
          `SELECT * FROM chat_message_queue
           WHERE session_id = ? AND claimed_at IS NULL AND delivery_state = 'queued'
           ORDER BY position ASC, created_at ASC, id ASC LIMIT 1`,
        )
        .get(session) as QueueRow | undefined;
      if (!row) {
        return null;
      }
      db.prepare('UPDATE chat_message_queue SET claimed_at = ? WHERE id = ?').run(claimedAt, row.id);
      return { ...row, claimed_at: claimedAt };
    });
    const row = claim(sessionId) as QueueRow | null;
    return row ? toQueuedMessage(row) : null;
  },

  /**
   * Возвращает захваченную строку в очередь — ход до агента её не довёз.
   * `bumpAttempts` — счётчик попыток доставки в `options.__redispatch`:
   * растёт только на реальной неудаче запуска (ход завёлся и упал до якоря),
   * а не на «место занято — завести не вышло». После потолка попыток вместо
   * возврата зовут `markFailed`.
   */
  releaseClaim(id: string, options?: { bumpAttempts?: boolean; notBefore?: number }): void {
    ensureTable();
    const db = getConnection();
    if (!options?.bumpAttempts) {
      db.prepare('UPDATE chat_message_queue SET claimed_at = NULL WHERE id = ?').run(id);
      return;
    }
    const row = db
      .prepare('SELECT options_json FROM chat_message_queue WHERE id = ?')
      .get(id) as { options_json: string } | undefined;
    if (!row) {
      return;
    }
    const parsed = parseOptions(row.options_json);
    parsed.__redispatch = Number(parsed.__redispatch ?? 0) + 1;
    if (options.notBefore) {
      parsed.__notBefore = options.notBefore;
    }
    db.prepare(
      'UPDATE chat_message_queue SET claimed_at = NULL, options_json = ? WHERE id = ?',
    ).run(JSON.stringify(parsed), id);
  },

  /**
   * Строка доехала: prompt записан выживающему процессу (promptAnchored).
   * Единственное место, где доставляемая строка уходит из таблицы молча —
   * дальше за неё отвечает ход агента.
   */
  markDelivered(id: string): void {
    ensureTable();
    getConnection().prepare('DELETE FROM chat_message_queue WHERE id = ?').run(id);
  },

  /**
   * Попытки исчерпаны: строка не удаляется, а помечается `failed` с причиной —
   * в доке она видна красной пометкой, человек решает сам (исправить, удалить,
   * попробовать ещё раз через «Сейчас»).
   */
  markFailed(id: string, error: string): void {
    ensureTable();
    getConnection()
      .prepare(
        `UPDATE chat_message_queue
         SET claimed_at = NULL, delivery_state = 'failed', last_error = ?
         WHERE id = ?`,
      )
      .run(error, id);
  },

  /**
   * `failed` → `queued`: человек нажал «Сейчас» на отказавшей строке или
   * поправил её — ошибку стираем, счётчик оставляем (он про доставку, а не
   * про разметку).
   */
  markQueued(id: string): void {
    ensureTable();
    getConnection()
      .prepare(
        `UPDATE chat_message_queue
         SET delivery_state = 'queued', last_error = NULL
         WHERE id = ?`,
      )
      .run(id);
  },

  /**
   * Подъём после рестарта: все захваты прошлого процесса снимаем — кто бы их
   * ни держал, он мёртв, а сообщение обязано доехать. Захваченные строки
   * текущего процесса при этом подъёме ещё не существуют.
   */
  releaseAllClaims(): number {
    ensureTable();
    const result = getConnection()
      .prepare(
        `UPDATE chat_message_queue SET claimed_at = NULL
         WHERE claimed_at IS NOT NULL AND delivery_state = 'queued'`,
      )
      .run();
    return result.changes;
  },

  /**
   * Страховка внутри одного процесса: захват, висящий дольше `olderThanMs`
   * при отсутствии живого хода, — осиротевший (нештатное завершение без
   * finally). Сторож очереди зовёт это по минутному интервалу.
   */
  releaseStaleClaims(sessionId: string, olderThanMs: number): number {
    ensureTable();
    const result = getConnection()
      .prepare(
        `UPDATE chat_message_queue SET claimed_at = NULL
         WHERE session_id = ? AND claimed_at IS NOT NULL AND claimed_at < ?
           AND delivery_state = 'queued'`,
      )
      .run(sessionId, Date.now() - olderThanMs);
    return result.changes;
  },

  /** Чаты с захваченными строками — сторож проверяет их на осиротевшие захваты. */
  sessionsWithClaims(): string[] {
    ensureTable();
    const rows = getConnection()
      .prepare('SELECT DISTINCT session_id FROM chat_message_queue WHERE claimed_at IS NOT NULL')
      .all() as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
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

  /**
   * Чаты, у которых есть ЧТО отправить: свободные строки в состоянии
   * `queued`. Захваченные (их везёт ход) и отказавшие (`failed` ждёт
   * решения человека) обход не трогает — иначе отправили бы дважды.
   */
  sessionsWithQueue(): string[] {
    ensureTable();
    const rows = getConnection()
      .prepare(
        `SELECT DISTINCT session_id FROM chat_message_queue
         WHERE claimed_at IS NULL AND delivery_state = 'queued'`,
      )
      .all() as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  },
};
