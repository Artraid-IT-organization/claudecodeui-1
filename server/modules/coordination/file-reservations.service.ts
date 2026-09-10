/**
 * Доска объявлений: кто из чатов какой файл сейчас правит.
 *
 * Задача. Замер по истории Егора за месяц: 351 случай, когда два разных чата
 * писали в один и тот же файл, из них 121 раз — с разрывом меньше двух минут.
 * 24 августа пять самостоятельных чатов правили один и тот же index.html.
 * Каждый такой случай — молча потерянная работа: программа читает файл целиком
 * и кладёт обратно целиком, поэтому чья запись легла последней, того и версия,
 * а первая исчезает без следа и без ошибки.
 *
 * Решение — как в MCP Agent Mail, но своей реализацией (сторонний пакет просит
 * Python 3.14, отдельный сервер на порту и хранилище, которое по своей
 * документации «не удаляет, а копит для аудита»; на этом сервере с четырьмя
 * свободными гигабайтами это плохой размен). Механику взяли ту же и главную:
 * не запирать намертво, а объявлять намерение и делать столкновение видимым
 * ДО того, как оно случится.
 *
 * Порядок работы. Перед правкой чат объявляет: «беру этот файл». Если файл уже
 * за другим живым чатом — новый ждёт, пока тот освободит, и лишь потом берётся.
 * Не дождался за отведённое время — получает отказ с внятным текстом, который
 * видно в ленте. После правки бронь снимается сразу; если чат умер, не сняв
 * её, бронь протухает сама по сроку.
 *
 * Память. Брони живут минутами, снимаются явно, протухают по сроку и
 * физически удаляются из базы через сутки. Ничего не копится «для истории».
 */
import { getConnection } from '@/modules/database/index.js';

/** Сколько живёт бронь, если её не сняли явно. Правка файла — это секунды. */
const DEFAULT_TTL_MS = 2 * 60 * 1000;

/** Сколько ждём освобождения чужого файла, прежде чем отказать. */
export const MAX_WAIT_MS = 30 * 1000;

/** Пауза между попытками взять занятый файл. */
const RETRY_INTERVAL_MS = 700;

/** Записи старше суток удаляются физически — доска не архив. */
const HARD_DELETE_AFTER_MS = 24 * 60 * 60 * 1000;

export type Reservation = {
  id: number;
  projectPath: string;
  filePath: string;
  sessionId: string;
  sessionTitle: string | null;
  createdAt: number;
  expiresAt: number;
};

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS file_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_title TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    released_at INTEGER
  )
`;

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getConnection();
  db.exec(CREATE_TABLE_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_file_reservations_active ON file_reservations(project_path, file_path, released_at, expires_at)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_file_reservations_session ON file_reservations(session_id, released_at)',
  );
  tableReady = true;
}

/** Прибирает протухшее и давнее. Вызывается попутно, отдельного крона не надо. */
function sweep(): void {
  const db = getConnection();
  const now = Date.now();
  // Протухшие помечаем снятыми — их больше никто не ждёт.
  db.prepare(
    'UPDATE file_reservations SET released_at = ? WHERE released_at IS NULL AND expires_at < ?',
  ).run(now, now);
  // Давние удаляем физически: доска объявлений не должна превращаться в архив.
  db.prepare('DELETE FROM file_reservations WHERE released_at IS NOT NULL AND released_at < ?').run(
    now - HARD_DELETE_AFTER_MS,
  );
}

type ReservationRow = {
  id: number;
  project_path: string;
  file_path: string;
  session_id: string;
  session_title: string | null;
  created_at: number;
  expires_at: number;
};

function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    projectPath: row.project_path,
    filePath: row.file_path,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Кто сейчас держит файл, кроме нас самих. */
function findHolder(
  projectPath: string,
  filePath: string,
  exceptSessionId: string,
): Reservation | null {
  const db = getConnection();
  const row = db
    .prepare(
      `SELECT id, project_path, file_path, session_id, session_title, created_at, expires_at
       FROM file_reservations
       WHERE project_path = ? AND file_path = ?
         AND released_at IS NULL AND expires_at > ?
         AND session_id != ?
       ORDER BY created_at
       LIMIT 1`,
    )
    .get(projectPath, filePath, Date.now(), exceptSessionId) as ReservationRow | undefined;
  return row ? toReservation(row) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type AcquireResult =
  | { ok: true; reservationId: number; waitedMs: number }
  | { ok: false; holder: Reservation; waitedMs: number };

export const fileReservations = {
  /**
   * Объявляет намерение править файл.
   *
   * Если файл свободен — берёт сразу. Если занят другим живым чатом — ждёт
   * освобождения до `maxWaitMs`, проверяя раз в несколько сотен миллисекунд.
   * Почти всегда это заканчивается за секунду: правка одного файла быстрая.
   */
  async acquire(input: {
    projectPath: string;
    filePath: string;
    sessionId: string;
    sessionTitle?: string | null;
    ttlMs?: number;
    maxWaitMs?: number;
  }): Promise<AcquireResult> {
    ensureTable();
    sweep();

    const { projectPath, filePath, sessionId } = input;
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
    const maxWait = input.maxWaitMs ?? MAX_WAIT_MS;
    const startedAt = Date.now();

    for (;;) {
      const holder = findHolder(projectPath, filePath, sessionId);
      if (!holder) {
        const now = Date.now();
        const db = getConnection();
        const result = db
          .prepare(
            `INSERT INTO file_reservations
               (project_path, file_path, session_id, session_title, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(projectPath, filePath, sessionId, input.sessionTitle ?? null, now, now + ttl);
        return {
          ok: true,
          reservationId: Number(result.lastInsertRowid),
          waitedMs: now - startedAt,
        };
      }

      const waited = Date.now() - startedAt;
      if (waited >= maxWait) {
        return { ok: false, holder, waitedMs: waited };
      }
      await sleep(RETRY_INTERVAL_MS);
      sweep();
    }
  },

  /** Снимает бронь сразу после правки. */
  release(reservationId: number): void {
    ensureTable();
    const db = getConnection();
    db.prepare('UPDATE file_reservations SET released_at = ? WHERE id = ? AND released_at IS NULL').run(
      Date.now(),
      reservationId,
    );
  },

  /** Снимает все брони разговора — на случай, если он завершился аварийно. */
  releaseSession(sessionId: string): void {
    ensureTable();
    const db = getConnection();
    db.prepare(
      'UPDATE file_reservations SET released_at = ? WHERE session_id = ? AND released_at IS NULL',
    ).run(Date.now(), sessionId);
  },

  /** Что сейчас занято в проекте — для показа человеку. */
  active(projectPath: string): Reservation[] {
    ensureTable();
    sweep();
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT id, project_path, file_path, session_id, session_title, created_at, expires_at
         FROM file_reservations
         WHERE project_path = ? AND released_at IS NULL AND expires_at > ?
         ORDER BY created_at`,
      )
      .all(projectPath, Date.now()) as ReservationRow[];
    return rows.map(toReservation);
  },
};
