/**
 * Группы чатов: «SunSchool», «Сайт Claude», «Финансы» и т.п.
 *
 * Смысл. Чатов у человека сотни, и список по датам не отвечает на вопрос «где
 * тот разговор про школу». Группа — это папка по делу. У чата она одна, а сам
 * чат по-прежнему лежит в своём проекте: группа не заменяет проект, а
 * раскладывает его чаты по темам.
 *
 * Кто раскладывает. Два источника, и у ручного приоритет:
 *   manual — человек сам выбрал группу в шапке чата (или «без группы»);
 *   auto   — сервер подобрал группу по словам из названия чата и пути проекта.
 * Автоматика трогает только чаты, которые человек не раскладывал. Если
 * название чата поменялось, подбор повторяется: группа «может меняться по мере
 * работы». Ручной выбор не пересматривается никогда.
 *
 * Где лежит связь. Колонки `group_id`/`group_label` у чата уже существовали:
 * по ним список слева рисует заголовки групп. Новая таблица хранит сами группы
 * (имя, слова для подбора), а у чата добавлен источник решения `group_source`.
 * Имя группы копируется в `group_label`, чтобы списку слева не нужен был
 * второй запрос.
 *
 * Разделение по аккаунтам. Группы привязаны к каталогу аккаунта Claude, как и
 * сами чаты: у второго пользователя площадки свои группы, чужих он не видит.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { getConnection } from '@/modules/database/connection.js';

/** manual — человек; auto — слова для подбора; ai — модель (chat-group-classifier). */
export type ChatGroupSource = 'manual' | 'auto' | 'ai';

export type ChatGroup = {
  id: string;
  name: string;
  /** Слова, по которым чат попадает в группу сам. Сравнение без учёта регистра. */
  keywords: string[];
  /** Сколько незаархивированных чатов сейчас в группе. */
  sessionCount: number;
  /** Последняя активность: самый свежий чат группы или последнее ручное назначение. */
  lastActivity: string | null;
  createdAt: string;
};

type ChatGroupRow = {
  id: string;
  account_dir: string;
  name: string;
  keywords: string;
  created_at: string;
  last_used_at: string | null;
  session_count: number;
  last_session_at: string | null;
};

type SessionForGrouping = {
  session_id: string;
  custom_name: string | null;
  project_path: string | null;
  account_dir: string | null;
  group_id: string | null;
  group_source: string | null;
  isArchived: number;
  origin: string | null;
};

const NAME_MAX = 40;
const KEYWORDS_MAX = 40;

// Готовность запоминается на подключение, а не навсегда: тесты и перезапуск
// базы дают новое подключение к файлу, где таблицы ещё может не быть.
let readyConnection: unknown = null;

export function ensureChatGroupsSchema(): void {
  ensureTable();
}

/**
 * Чат, созданный программой, а не человеком. Признак пути надёжнее названия:
 * тестовые прогоны 13.09.26 шли через настоящий терминал (`origin` terminal),
 * но всегда в одноразовых папках. В группы такие чаты не попадают — Егор
 * 16.09.26: «не записывать туда чаты, которые создала нейросеть».
 */
export function isMachineMadeChat(row: { origin: string | null; project_path: string | null }): boolean {
  if (row.origin === 'auto') return true;
  const projectPath = row.project_path ?? '';
  if (projectPath.startsWith('/tmp/') || projectPath.startsWith(`${os.tmpdir()}/`)) return true;
  return projectPath.split('/').some((segment) => /^e2e(?:[-_]|$)/i.test(segment));
}

function ensureTable(): void {
  const db = getConnection();
  if (readyConnection === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_groups (
      id TEXT PRIMARY KEY,
      account_dir TEXT NOT NULL,
      name TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    )
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_groups_account_name ON chat_groups(account_dir, name)');

  const columns = (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes('group_source')) {
    db.exec('ALTER TABLE sessions ADD COLUMN group_source TEXT');
  }
  // Тема-кандидат от модели и название, которое модель при этом видела.
  if (!columns.includes('group_hint')) {
    db.exec('ALTER TABLE sessions ADD COLUMN group_hint TEXT');
  }
  if (!columns.includes('group_hint_title')) {
    db.exec('ALTER TABLE sessions ADD COLUMN group_hint_title TEXT');
  }
  readyConnection = db;
}

function parseKeywords(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function normalizeKeywords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const word = item.trim().toLowerCase();
    if (word.length >= 2 && word.length <= 60) seen.add(word);
    if (seen.size >= KEYWORDS_MAX) break;
  }
  return [...seen];
}

export function normalizeGroupName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new Error('у группы должно быть имя');
  if (name.length > NAME_MAX) throw new Error(`имя группы длиннее ${NAME_MAX} символов`);
  return name;
}

function toGroup(row: ChatGroupRow): ChatGroup {
  // Даты чатов пишутся как «2026-09-12T14:37», а отметка базы — через пробел.
  // Без выравнивания строки сравнивались бы по символу-разделителю, а не по времени.
  const candidates = [row.last_session_at, row.last_used_at]
    .filter(Boolean)
    .map((value) => String(value).replace(' ', 'T'));
  return {
    id: row.id,
    name: row.name,
    keywords: parseKeywords(row.keywords),
    sessionCount: row.session_count,
    lastActivity: candidates.length ? candidates.sort().at(-1) ?? null : null,
    createdAt: row.created_at,
  };
}

/**
 * Подбирает группу по словам. Первое совпадение по порядку групп выигрывает —
 * порядок задаётся списком, который отдаёт `pickGroupsForMatching` (от старых
 * к новым), чтобы новая группа с общим словом не перетягивала чаты у старой.
 */
export function matchGroupForText(
  text: string,
  groups: Array<{ id: string; name: string; keywords: string[] }>,
): { id: string; name: string } | null {
  const haystack = text.toLowerCase();
  for (const group of groups) {
    if (group.keywords.some((word) => startsWordAt(haystack, word))) {
      return { id: group.id, name: group.name };
    }
  }
  return null;
}

/**
 * Слово для подбора должно стоять С НАЧАЛА слова в тексте: «бот» находит
 * «Бот не отвечает» и «ботов», но не «Работа». Простой поиск подстроки на
 * живых данных отправил «Работа c Thoughts» в «Телеграм-боты» — а «работа»
 * одно из самых частых слов в названиях. Конец слова не проверяется намеренно:
 * «бриф» должен находить «брифы», «заставк» — «заставка».
 */
function startsWordAt(haystack: string, word: string): boolean {
  let index = haystack.indexOf(word);
  while (index >= 0) {
    if (index === 0 || !/[\p{L}\p{N}]/u.test(haystack[index - 1])) {
      return true;
    }
    index = haystack.indexOf(word, index + 1);
  }
  return false;
}

export const chatGroupsDb = {
  /** Группы аккаунта, самые свежие сверху. */
  list(accountDir: string): ChatGroup[] {
    ensureTable();
    const rows = getConnection()
      .prepare(
        `SELECT g.id, g.account_dir, g.name, g.keywords, g.created_at, g.last_used_at,
                COUNT(s.session_id) AS session_count,
                MAX(COALESCE(s.updated_at, s.created_at)) AS last_session_at
         FROM chat_groups g
         LEFT JOIN sessions s ON s.group_id = g.id AND s.isArchived = 0
         WHERE g.account_dir = ?
         GROUP BY g.id`,
      )
      .all(accountDir) as ChatGroupRow[];

    return rows
      .map(toGroup)
      .sort((a, b) => String(b.lastActivity ?? b.createdAt).localeCompare(String(a.lastActivity ?? a.createdAt)));
  },

  get(accountDir: string, groupId: string): ChatGroup | null {
    return chatGroupsDb.list(accountDir).find((group) => group.id === groupId) ?? null;
  },

  create(accountDir: string, input: { name: unknown; keywords?: unknown }): ChatGroup {
    ensureTable();
    const name = normalizeGroupName(input.name);
    const db = getConnection();
    const existing = db
      .prepare('SELECT id FROM chat_groups WHERE account_dir = ? AND name = ?')
      .get(accountDir, name) as { id: string } | undefined;
    if (existing) {
      throw new Error(`группа «${name}» уже есть`);
    }

    const id = randomUUID();
    db.prepare('INSERT INTO chat_groups (id, account_dir, name, keywords) VALUES (?, ?, ?, ?)').run(
      id,
      accountDir,
      name,
      JSON.stringify(normalizeKeywords(input.keywords)),
    );
    return chatGroupsDb.get(accountDir, id) as ChatGroup;
  },

  update(accountDir: string, groupId: string, input: { name?: unknown; keywords?: unknown }): ChatGroup | null {
    ensureTable();
    const current = chatGroupsDb.get(accountDir, groupId);
    if (!current) return null;

    const name = input.name !== undefined ? normalizeGroupName(input.name) : current.name;
    const keywords = input.keywords !== undefined ? normalizeKeywords(input.keywords) : current.keywords;
    const db = getConnection();
    db.transaction(() => {
      db.prepare('UPDATE chat_groups SET name = ?, keywords = ? WHERE id = ? AND account_dir = ?').run(
        name,
        JSON.stringify(keywords),
        groupId,
        accountDir,
      );
      // Имя копией лежит у чатов — переименование должно доехать и до них.
      db.prepare('UPDATE sessions SET group_label = ? WHERE group_id = ?').run(name, groupId);
    })();
    return chatGroupsDb.get(accountDir, groupId);
  },

  /**
   * Ручное решение человека: положить чат в группу или вынуть из всех
   * (`groupId: null`). Запоминается как `manual` — автоматика его не тронет.
   * Возвращает false, если группа не принадлежит этому аккаунту.
   */
  assignManually(accountDir: string, sessionId: string, groupId: string | null): boolean {
    ensureTable();
    const db = getConnection();
    let label: string | null = null;
    if (groupId) {
      const group = db
        .prepare('SELECT name FROM chat_groups WHERE id = ? AND account_dir = ?')
        .get(groupId, accountDir) as { name: string } | undefined;
      if (!group) return false;
      label = group.name;
      db.prepare('UPDATE chat_groups SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(groupId);
    }
    const result = db
      .prepare(
        `UPDATE sessions SET group_id = ?, group_label = ?, group_source = 'manual'
         WHERE session_id = ? AND (account_dir IS NULL OR account_dir = ?)`,
      )
      .run(groupId, label, sessionId, accountDir);
    return result.changes > 0;
  },

  /**
   * Подбор группы для одного чата. Вызывается, когда чат появился или сменил
   * название. Возвращает true, если группа у чата поменялась.
   */
  autoAssignSession(sessionId: string): boolean {
    ensureTable();
    const db = getConnection();
    const session = db
      .prepare(
        `SELECT session_id, custom_name, project_path, account_dir, group_id, group_source, isArchived, origin
         FROM sessions WHERE session_id = ?`,
      )
      .get(sessionId) as SessionForGrouping | undefined;
    if (!session || !session.account_dir || session.group_source === 'manual') {
      return false;
    }
    if (isMachineMadeChat(session)) {
      return false;
    }
    // Чаты, сгруппированные старой кнопкой «Organize by topic», имеют свои
    // группы без записи в таблице — их тоже не трогаем.
    if (session.group_id && session.group_source !== 'auto' && session.group_source !== 'ai') {
      return false;
    }

    const groups = pickGroupsForMatching(session.account_dir);
    const match = matchGroupForText(`${session.custom_name ?? ''} ${session.project_path ?? ''}`, groups);
    // Словами не подобралось, а модель уже положила чат в группу — её решение
    // остаётся. Сменится название — модель разберёт чат заново сама.
    if (!match && session.group_source === 'ai') {
      return false;
    }
    const nextId = match?.id ?? null;
    if (nextId === session.group_id) {
      return false;
    }

    db.prepare(
      `UPDATE sessions SET group_id = ?, group_label = ?, group_source = ?
       WHERE session_id = ?`,
    ).run(nextId, match?.name ?? null, match ? 'auto' : null, sessionId);
    return true;
  },

  /** Разложить все чаты аккаунта, которые человек не раскладывал сам. */
  autoAssignAll(accountDir: string): string[] {
    ensureTable();
    const ids = (
      getConnection()
        .prepare(
          `SELECT session_id FROM sessions
           WHERE account_dir = ? AND (group_source IS NULL OR group_source IN ('auto', 'ai'))`,
        )
        .all(accountDir) as Array<{ session_id: string }>
    ).map((row) => row.session_id);

    return ids.filter((id) => chatGroupsDb.autoAssignSession(id));
  },

  /** Текущая группа и признак архива одного чата — для шапки. */
  getSessionGrouping(
    accountDir: string,
    sessionId: string,
  ): { groupId: string | null; groupSource: ChatGroupSource | null; isArchived: boolean } | null {
    ensureTable();
    const row = getConnection()
      .prepare(
        `SELECT group_id, group_source, isArchived FROM sessions
         WHERE session_id = ? AND (account_dir IS NULL OR account_dir = ?)`,
      )
      .get(sessionId, accountDir) as { group_id: string | null; group_source: string | null; isArchived: number } | undefined;
    if (!row) return null;
    return {
      groupId: row.group_id,
      groupSource: row.group_source === 'manual' || row.group_source === 'auto' || row.group_source === 'ai' ? row.group_source : null,
      isArchived: Boolean(row.isArchived),
    };
  },
};

/** Группы в порядке создания: старшая группа выигрывает при общих словах. */
function pickGroupsForMatching(accountDir: string): Array<{ id: string; name: string; keywords: string[] }> {
  const rows = getConnection()
    .prepare('SELECT id, name, keywords FROM chat_groups WHERE account_dir = ? ORDER BY created_at, rowid')
    .all(accountDir) as Array<{ id: string; name: string; keywords: string }>;
  return rows.map((row) => ({ id: row.id, name: row.name, keywords: parseKeywords(row.keywords) }));
}
