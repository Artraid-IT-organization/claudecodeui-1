import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

// snowball-stemmers — чистый CommonJS без default-экспорта; через require он
// ведёт себя одинаково в tsx-тестах и собранном dist-server.
const snowballFactory = createRequire(import.meta.url)('snowball-stemmers') as {
  newStemmer: (algorithm: string) => { stem: (word: string) => string };
  algorithms: () => string[];
};

import { projectsDb } from '@/modules/database/index.js';
import { fullDevinConversation } from '@/modules/providers/list/devin/devin-chain.js';
import { ensureSearchIndex, type IndexedMessage, type RecordExtractor } from '@/modules/providers/services/session-search-index.service.js';
import { getDevinDatabasePath, isDevinAutoContinueText, readJsonRecord, readOptionalString } from '@/shared/utils.js';

/**
 * Полнотекстовый индекс чатов на SQLite FTS5 (та же связка, что у Joplin
 * notes_fts и Signal messages_fts): одна строка индекса на чат, bm25 сам
 * учитывает частоту слова в тексте, поэтому «чем чаще фраза встречается,
 * тем выше чат» работает без отдельного счётчика.
 *
 * Русская морфология — на стороне запроса: каждое слово запроса приводится
 * стеммером Snowball к основе (она всегда префикс исходного слова), а в FTS
 * уходит префиксный запрос «основа*». Так «выкатки» находит «выкатка»,
 * «выкатку» и «выкаткой». Индекс хранит исходные тексты (только ё→е для
 * сопоставления), поэтому сниппеты остаются читаемыми.
 *
 * Индекс инкрементальный: состояние каждого чата (название, время активности,
 * mtime файла переписки) лежит в index_state; reconcile пишет только
 * изменившиеся строки. База отдельным файлом рядом с базой экземпляра —
 * у изолированной копии свой индекс автоматически.
 */

type AnyRecord = Record<string, any>;

const CYRILLIC_RE = /[а-яё]/i;
const WORD_RE = /[\p{L}\p{N}]+/gu;
const SNIPPET_OPEN = '⟦';
const SNIPPET_CLOSE = '⟧';
// Меньше не имеет смысла вести в индекс: однобуквенные «слова» — шум.
const MIN_WORD_LEN = 2;
// Стем короче трёх букв даёт слишком широкий префикс — берём само слово.
const MIN_STEM_LEN = 3;
// Верхняя граница тела чата в индексе: хвост длиннейших переписок не нужен
// для «найти чат», а строка FTS остаётся разумного размера.
const MAX_BODY_CHARS = 1_500_000;

const ruStemmer = snowballFactory.newStemmer('russian');
const enStemmer = snowballFactory.newStemmer('english');

type ChatSearchDb = InstanceType<typeof Database>;

let searchDb: ChatSearchDb | null = null;

function getSearchDbPath(): string {
  const dbPath = process.env.DATABASE_PATH;
  const base = dbPath ? path.dirname(dbPath) : path.join(os.homedir(), '.cloudcli');
  return path.join(base, 'chat-search.db');
}

function openSearchDb(): ChatSearchDb {
  if (searchDb) {
    return searchDb;
  }
  const filePath = getSearchDbPath();
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_state (
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      fts_rowid INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      PRIMARY KEY (provider, session_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_docs USING fts5(
      title,
      body,
      session_id UNINDEXED,
      provider UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  searchDb = db;
  return db;
}

/** Только для тестов/изолированных копий: закрыть и забыть соединение. */
export function closeChatSearchDbForTests(): void {
  searchDb?.close();
  searchDb = null;
}

/**
 * ё и Ё не складываются unicode61 (ё — отдельная буква, не е+диакритика),
 * поэтому нормализация делается вручную и при индексации, и при запросе.
 * Регистр не трогаем: токенайзер складывает регистр сам, а сниппет читабельнее.
 */
function normalizeSearchText(text: string): string {
  return text.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
}

function queryWords(query: string): string[] {
  return (query.toLowerCase().match(WORD_RE) ?? []).filter((word) => word.length >= MIN_WORD_LEN);
}

/** Основа слова для префиксного запроса: Snowball-стемма — всегда префикс слова. */
function stemOf(word: string): string {
  const stem = CYRILLIC_RE.test(word) ? ruStemmer.stem(word) : enStemmer.stem(word);
  return stem.length >= MIN_STEM_LEN ? stem : word;
}

/**
 * Одно слово запроса → набор поисковых термов (основа и само слово как
 * префиксы). Оба варианта нужны: стемма ловит словоформы, а когда стемминг
 * ничего не дал (редкие суплетивные/искажённые формы) префикс слова — то,
 * что человек набрал буква в букву.
 */
function termsForWord(word: string): string[] {
  const stem = stemOf(word);
  return stem === word ? [word] : [stem, word];
}

/** FTS5 MATCH: AND по словам, внутри слова — OR термов; каждый терм — префикс. */
function buildMatchQuery(words: string[], column: 'title' | 'body'): string {
  return words
    .map((word) => {
      const terms = termsForWord(word).map((term) => `${term}*`).join(' OR ');
      return `${column} : (${terms})`;
    })
    .join(' ');
}

/** Точная фраза как бонус: сырой текст запроса одной FTS-фразой. */
function buildPhraseQuery(words: string[], column: 'body'): string | null {
  if (words.length < 2) {
    return null;
  }
  return `${column} : "${words.join(' ')}"`;
}

// Веса итоговой формулы ранжирования (настраиваемые, все в одном месте):
//   tier: название > содержимое > нечёткое — жёсткий порядок секций выдачи;
//   внутри названия: точное > с начала названия > по основам слов > подстрока;
//   внутри содержимого: -bm25 (частота) + фраза как бонус, свежесть — тай-брейк.
const TITLE_WEIGHT = {
  exact: 40,
  startsWith: 30,
  wordStems: 20,
  substring: 10,
};
const CONTENT_PHRASE_BONUS = 2.0;
const FUZZY_MAX_TITLE_EDIT = 2;
const FUZZY_MAX_TERMS_PER_WORD = 6;

type SessionRowLike = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  custom_name: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  updated_at: string | null;
  created_at: string | null;
  devin_connection_id?: number | null;
};

function sessionTime(session: Pick<SessionRowLike, 'updated_at' | 'created_at'>): number {
  const value = new Date(session.updated_at || session.created_at || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function sessionFingerprint(session: SessionRowLike): string {
  // updated_at меняется при новых сообщениях (его же обновляет синхронизатор),
  // custom_name — при переименовании. Для файловых провайдеров добавляем mtime
  // переписки: она растёт при дописывании даже если updated_at запаздывает.
  let fileSig = '';
  if (session.provider !== 'devin' && session.jsonl_path) {
    try {
      const stat = fsSync.statSync(session.jsonl_path);
      fileSig = `|${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    } catch {
      fileSig = '|nofile';
    }
  }
  return `${session.custom_name ?? ''}|${session.updated_at ?? ''}${fileSig}`;
}

function readDigestTextsForSession(
  indexPath: string,
  provider: string,
  providerSessionId: string | null,
): string[] {
  const texts: string[] = [];
  let raw: string;
  try {
    raw = fsSync.readFileSync(indexPath, 'utf8');
  } catch {
    return texts;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let message: IndexedMessage;
    try {
      message = JSON.parse(line) as IndexedMessage;
    } catch {
      continue;
    }
    // У Claude в одном файле бывает несколько разговоров — строка помечена
    // номером разговора провайдера. Codex пишет по файлу на чат, s пуст.
    if (provider !== 'codex' && message.s && providerSessionId && message.s !== providerSessionId) {
      continue;
    }
    if (provider !== 'codex' && providerSessionId && !message.s) {
      continue;
    }
    if (typeof message.x === 'string' && message.x.trim()) {
      texts.push(message.x);
    }
  }
  return texts;
}

function extractDevinTexts(
  db: ChatSearchDb,
  providerSessionId: string,
): string[] {
  const texts: string[] = [];
  for (const row of fullDevinConversation(db, providerSessionId)) {
    const message = readJsonRecord(row.chatMessage);
    if (!message) continue;
    const role = readOptionalString(message.role);
    const metadata = message.metadata as AnyRecord | undefined;
    if (role === 'user') {
      if (metadata?.is_user_input !== true) continue;
      const content = readOptionalString(message.content);
      if (content && !isDevinAutoContinueText(content)) {
        texts.push(content);
      }
    } else if (role === 'assistant') {
      const content = readOptionalString(message.content);
      if (content && content.trim()) {
        texts.push(content);
      }
    }
  }
  return texts;
}

type DevinConnectionsDbLike = { getById: (id: number) => { xdg_data_home: string | null } | null | undefined };

async function buildSessionBody(
  session: SessionRowLike,
  extractorFor: (provider: 'claude' | 'codex') => RecordExtractor,
  devinConnectionsDb: DevinConnectionsDbLike | null,
  devinDbCache: Map<string, ChatSearchDb | null>,
): Promise<string> {
  if (session.provider === 'devin') {
    const providerSessionId = session.provider_session_id ?? session.session_id;
    const connId = session.devin_connection_id ?? null;
    const xdg = connId != null ? devinConnectionsDb?.getById(connId)?.xdg_data_home ?? null : null;
    const dbPath = getDevinDatabasePath(xdg);
    if (!devinDbCache.has(dbPath)) {
      let opened: ChatSearchDb | null = null;
      try {
        opened = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch {
        opened = null;
      }
      devinDbCache.set(dbPath, opened);
    }
    const db = devinDbCache.get(dbPath) ?? null;
    if (!db) return '';
    try {
      return extractDevinTexts(db, providerSessionId).join('\n');
    } catch {
      return '';
    }
  }

  if (!session.jsonl_path) {
    return '';
  }
  const indexPath = await ensureSearchIndex(
    session.jsonl_path,
    session.provider as 'claude' | 'codex',
    extractorFor(session.provider as 'claude' | 'codex'),
  );
  if (!indexPath) {
    return '';
  }
  return readDigestTextsForSession(indexPath, session.provider, session.provider_session_id ?? session.session_id).join('\n');
}

function upsertSessionDoc(
  db: ChatSearchDb,
  session: SessionRowLike,
  body: string,
): void {
  const title = normalizeSearchText(session.custom_name ?? '');
  const normalizedBody = normalizeSearchText(
    body.length > MAX_BODY_CHARS ? body.slice(-MAX_BODY_CHARS) : body,
  );
  const upsert = db.transaction(() => {
    const existing = db
      .prepare('SELECT fts_rowid FROM index_state WHERE provider = ? AND session_id = ?')
      .get(session.provider, session.session_id) as { fts_rowid: number } | undefined;
    if (existing) {
      db.prepare('DELETE FROM chat_docs WHERE rowid = ?').run(existing.fts_rowid);
    }
    const info = db
      .prepare('INSERT INTO chat_docs (title, body, session_id, provider) VALUES (?, ?, ?, ?)')
      .run(title, normalizedBody, session.session_id, session.provider);
    db.prepare(
      'INSERT OR REPLACE INTO index_state (session_id, provider, fingerprint, fts_rowid, indexed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(session.session_id, session.provider, sessionFingerprint(session), Number(info.lastInsertRowid), Date.now());
  });
  upsert();
}

function deleteSessionDoc(db: ChatSearchDb, provider: string, sessionId: string): void {
  const row = db
    .prepare('SELECT fts_rowid FROM index_state WHERE provider = ? AND session_id = ?')
    .get(provider, sessionId) as { fts_rowid: number } | undefined;
  if (row) {
    db.prepare('DELETE FROM chat_docs WHERE rowid = ?').run(row.fts_rowid);
    db.prepare('DELETE FROM index_state WHERE provider = ? AND session_id = ?').run(provider, sessionId);
  }
}

export type ReconcileOptions = {
  /** Потолок работы за один вызов — на запросе ввод не ждёт полной сверки. */
  maxSessions?: number;
  budgetMs?: number;
  extractorFor?: (provider: 'claude' | 'codex') => RecordExtractor;
  devinConnectionsDb?: DevinConnectionsDbLike | null;
  projectIsArchived?: (projectPath: string) => boolean;
};

export type ReconcileResult = { scanned: number; indexed: number; deleted: number; remaining: number };

const defaultArchivedCheck = (projectPath: string): boolean => {
  if (!projectPath) return false;
  return Boolean(projectsDb.getProjectPath(projectPath)?.isArchived);
};

/**
 * Сверка индекса со списком чатов. Грязные — по отпечатку (название + время
 * активности + mtime переписки); удалённые из базы чаты убираются из индекса.
 * Архивные папки не индексируются вовсе — как и в старом поиске.
 */
export async function reconcileChatSearchIndex(
  sessions: SessionRowLike[],
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const db = openSearchDb();
  const maxSessions = options.maxSessions ?? 250;
  const budgetMs = options.budgetMs ?? 1500;
  const startedAt = Date.now();
  const isArchived = options.projectIsArchived ?? defaultArchivedCheck;
  const extractorFor = options.extractorFor;
  const devinDbCache = new Map<string, ChatSearchDb | null>();

  const stateRows = db.prepare('SELECT provider, session_id, fingerprint FROM index_state').all() as Array<{
    provider: string;
    session_id: string;
    fingerprint: string;
  }>;
  const stateByKey = new Map(stateRows.map((row) => [`${row.provider}:${row.session_id}`, row.fingerprint]));

  const desired = new Map<string, SessionRowLike>();
  for (const session of sessions) {
    desired.set(`${session.provider}:${session.session_id}`, session);
  }

  let deleted = 0;
  for (const row of stateRows) {
    const key = `${row.provider}:${row.session_id}`;
    if (!desired.has(key)) {
      deleteSessionDoc(db, row.provider, row.session_id);
      deleted += 1;
    }
  }

  const dirty: SessionRowLike[] = [];
  for (const session of sessions) {
    const key = `${session.provider}:${session.session_id}`;
    if (isArchived((session.project_path ?? '').trim())) {
      if (stateByKey.has(key)) {
        deleteSessionDoc(db, session.provider, session.session_id);
        deleted += 1;
      }
      continue;
    }
    if (stateByKey.get(key) === sessionFingerprint(session)) {
      continue;
    }
    dirty.push(session);
  }
  // Свежие чаты — первыми: их индекс актуализируем в первую очередь.
  dirty.sort((left, right) => sessionTime(right) - sessionTime(left));

  let indexed = 0;
  try {
    for (const session of dirty.slice(0, maxSessions)) {
      if (Date.now() - startedAt > budgetMs) {
        break;
      }
      const body = extractorFor
        ? await buildSessionBody(session, extractorFor, options.devinConnectionsDb ?? null, devinDbCache)
        : '';
      upsertSessionDoc(db, session, body);
      indexed += 1;
    }
  } finally {
    for (const dbHandle of devinDbCache.values()) {
      try {
        dbHandle?.close();
      } catch {
        // ignore
      }
    }
  }

  return { scanned: sessions.length, indexed, deleted, remaining: dirty.length - indexed };
}

/** Одно слово → термы словаря в пределах редакционного расстояния. */
function fuzzyTermsForWord(db: ChatSearchDb, word: string): string[] {
  const maxEdit = word.length > 7 ? FUZZY_MAX_TITLE_EDIT : 1;
  const prefix = word.slice(0, Math.max(2, Math.floor(word.length / 2)));
  const candidates = db
    .prepare("SELECT term FROM chat_docs_vocab WHERE term >= ? AND term < ? LIMIT 4000")
    .all(prefix, `${prefix}\uFFFF`) as Array<{ term: string }>;
  const terms: string[] = [];
  for (const { term } of candidates) {
    if (terms.length >= FUZZY_MAX_TERMS_PER_WORD) break;
    if (Math.abs(term.length - word.length) > maxEdit) continue;
    if (levenshteinAtMost(term, word, maxEdit)) {
      terms.push(term);
    }
  }
  return terms;
}

/** Расстояние Левенштейна с ранним выходом — только «в пределах max». */
function levenshteinAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, idx) => idx);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return false;
    prev = curr;
  }
  return prev[b.length] <= max;
}

function ensureVocabTable(db: ChatSearchDb): void {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chat_docs_vocab USING fts5vocab(chat_docs, 'row')");
  } catch {
    // fts5vocab недоступен — нечёткий ярус по содержимому просто не даст термов.
  }
}

export type RankedSessionHit = {
  sessionId: string;
  provider: string;
  tier: 'title' | 'content' | 'fuzzy';
  /** Балл внутри яруса: чем больше, тем выше. */
  score: number;
  titleScore: number;
  snippet: string;
  highlights: Array<{ start: number; end: number }>;
  lastActivity: number;
};

type TitleMatchInput = {
  sessionId: string;
  provider: string;
  title: string;
  lastActivity: number;
};

/** Совпадение названия: точное / с начала / по основам слов / подстрока. */
function titleScore(title: string, normalizedQuery: string, words: string[]): number {
  const normalizedTitle = normalizeSearchText(title).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalizedTitle) return 0;
  if (normalizedTitle === normalizedQuery) return TITLE_WEIGHT.exact;
  if (normalizedTitle.startsWith(normalizedQuery)) return TITLE_WEIGHT.startsWith;
  if (normalizedTitle.includes(normalizedQuery)) return TITLE_WEIGHT.substring;
  const titleWords = normalizedTitle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const allStemsCovered = words.every((word) =>
    titleWords.some((titleWord) => titleWord.startsWith(stemOf(word)) || titleWord.startsWith(word)));
  if (allStemsCovered) return TITLE_WEIGHT.wordStems;
  return 0;
}

function snippetToHighlights(marked: string): { text: string; highlights: Array<{ start: number; end: number }> } {
  const highlights: Array<{ start: number; end: number }> = [];
  let text = '';
  let cursor = 0;
  for (;;) {
    const open = marked.indexOf(SNIPPET_OPEN, cursor);
    if (open === -1) {
      text += marked.slice(cursor);
      break;
    }
    const close = marked.indexOf(SNIPPET_CLOSE, open + SNIPPET_OPEN.length);
    if (close === -1) {
      text += marked.slice(cursor);
      break;
    }
    text += marked.slice(cursor, open);
    const start = text.length;
    text += marked.slice(open + SNIPPET_OPEN.length, close);
    highlights.push({ start, end: text.length });
    cursor = close + SNIPPET_CLOSE.length;
  }
  return { text, highlights };
}

export type ChatSearchInput = {
  query: string;
  /** Кандидаты яруса названий — уже отфильтрованные по области поиска. */
  titleCandidates: TitleMatchInput[];
  /** Ограничение множества для содержимого (область поиска), null — весь индекс. */
  allowedKeys: Set<string> | null;
  limit: number;
};

/**
 * Выдача тремя ярусами: название → содержимое (bm25/частота, фраза бонусом)
 * → нечёткое (словарь в редакционном расстоянии). Свежесть — тай-брейк везде.
 */
export function searchChatDocs(input: ChatSearchInput): RankedSessionHit[] {
  const db = openSearchDb();
  ensureVocabTable(db);
  const normalizedQuery = normalizeSearchText(input.query).toLowerCase().replace(/\s+/g, ' ').trim();
  const words = queryWords(normalizedQuery);
  if (!normalizedQuery || words.length === 0) {
    return [];
  }

  const hits: RankedSessionHit[] = [];
  const seen = new Set<string>();
  const hitByKey = new Map<string, RankedSessionHit>();

  // Ярус 1 — названия.
  const titleHits = input.titleCandidates
    .map((candidate) => ({
      candidate,
      score: titleScore(candidate.title, normalizedQuery, words),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.candidate.lastActivity - left.candidate.lastActivity);

  for (const { candidate, score } of titleHits) {
    const key = `${candidate.provider}:${candidate.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit: RankedSessionHit = {
      sessionId: candidate.sessionId,
      provider: candidate.provider,
      tier: 'title',
      score,
      titleScore: score,
      snippet: '',
      highlights: [],
      lastActivity: candidate.lastActivity,
    };
    hitByKey.set(key, hit);
    hits.push(hit);
  }

  const isAllowed = (provider: string, sessionId: string): boolean =>
    input.allowedKeys === null || input.allowedKeys.has(`${provider}:${sessionId}`);

  // Ярус 2 — содержимое: AND по основам слов, bm25 отвечает за частоту.
  const matchQuery = buildMatchQuery(words, 'body');
  const phraseQuery = buildPhraseQuery(words, 'body');
  const phraseHitKeys = new Set<string>();
  if (phraseQuery) {
    try {
      const rows = db
        .prepare('SELECT session_id, provider FROM chat_docs WHERE chat_docs MATCH ? LIMIT 500')
        .all(phraseQuery) as Array<{ session_id: string; provider: string }>;
      for (const row of rows) {
        phraseHitKeys.add(`${row.provider}:${row.session_id}`);
      }
    } catch {
      // Кривая фраза — бонус просто не применяется.
    }
  }

  type ContentRow = {
    session_id: string;
    provider: string;
    bm: number;
    snip: string | null;
  };
  let contentRows: ContentRow[] = [];
  try {
    // Сначала топ по баллу без сниппета — snippet() дорогой, его считаем
    // только для строк, которые реально уйдут на экран.
    const topRows = db
      .prepare(
        `SELECT rowid, session_id, provider, bm25(chat_docs) AS bm
         FROM chat_docs WHERE chat_docs MATCH ?
         ORDER BY bm ASC LIMIT ?`,
      )
      .all(matchQuery, Math.max(input.limit * 4, 200)) as Array<ContentRow & { rowid: number }>;
    const snipStmt = db.prepare(
      `SELECT snippet(chat_docs, 1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 18) AS snip
       FROM chat_docs WHERE rowid = ?`,
    );
    contentRows = topRows.map((row) => ({
      ...row,
      snip: (snipStmt.get(row.rowid) as { snip: string | null } | undefined)?.snip ?? null,
    }));
  } catch {
    contentRows = [];
  }

  const activityByKey = new Map(input.titleCandidates.map((c) => [`${c.provider}:${c.sessionId}`, c.lastActivity]));
  const contentHits: RankedSessionHit[] = [];
  for (const row of contentRows) {
    const key = `${row.provider}:${row.session_id}`;
    if (!isAllowed(row.provider, row.session_id)) {
      continue;
    }
    const { text, highlights } = snippetToHighlights(row.snip ?? '');
    // Чат уже найден по названию — остаётся в своём ярусе, но сниппет из
    // переписки показываем под ним (раньше это же делал клиентский мерж).
    const titleHit = hitByKey.get(key);
    if (titleHit) {
      if (text && !titleHit.snippet) {
        titleHit.snippet = text;
        titleHit.highlights = highlights;
      }
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const phraseBonus = phraseHitKeys.has(key) ? CONTENT_PHRASE_BONUS : 0;
    contentHits.push({
      sessionId: row.session_id,
      provider: row.provider,
      tier: 'content',
      // bm25 отрицателен и «меньше = лучше» — переворачиваем в «больше = выше».
      score: -row.bm + phraseBonus,
      titleScore: 0,
      snippet: text,
      highlights,
      lastActivity: activityByKey.get(key) ?? 0,
    });
  }
  contentHits.sort((left, right) => right.score - left.score || right.lastActivity - left.lastActivity);
  hits.push(...contentHits);

  // Ярус 3 — нечёткое: термы словаря в редакционном расстоянии от слов
  // запроса. Дорогой обход словаря оправдан только когда точных находок мало
  // (опечатка или редкая форма) — при полной выдаче «похожие» всё равно за
  // краем экрана.
  if (hits.length >= input.limit && contentHits.length >= 10) {
    return hits.slice(0, Math.max(input.limit, 1));
  }
  const fuzzyPerWord = words.map((word) => {
    const stemTerms = termsForWord(word);
    const fuzzy = fuzzyTermsForWord(db, word).filter((term) => !stemTerms.includes(term) && !term.startsWith(stemTerms[0]));
    return fuzzy;
  });
  if (fuzzyPerWord.every((terms) => terms.length > 0)) {
    const fuzzyQuery = fuzzyPerWord
      .map((terms) => `body : (${terms.map((term) => `${term}*`).join(' OR ')})`)
      .join(' ');
    try {
      const fuzzyRows = db
        .prepare(
          `SELECT session_id, provider, bm25(chat_docs) AS bm,
                  snippet(chat_docs, 1, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 18) AS snip
           FROM chat_docs WHERE chat_docs MATCH ?
           ORDER BY bm ASC LIMIT 60`,
        )
        .all(fuzzyQuery) as ContentRow[];
      const fuzzyHits: RankedSessionHit[] = [];
      for (const row of fuzzyRows) {
        const key = `${row.provider}:${row.session_id}`;
        if (seen.has(key) || !isAllowed(row.provider, row.session_id)) {
          continue;
        }
        seen.add(key);
        const { text, highlights } = snippetToHighlights(row.snip ?? '');
        fuzzyHits.push({
          sessionId: row.session_id,
          provider: row.provider,
          tier: 'fuzzy',
          score: -row.bm,
          titleScore: 0,
          snippet: text,
          highlights,
          lastActivity: activityByKey.get(key) ?? 0,
        });
      }
      fuzzyHits.sort((left, right) => right.score - left.score || right.lastActivity - left.lastActivity);
      hits.push(...fuzzyHits);
    } catch {
      // Нечёткий ярус — бонус, его отсутствие не блокирует выдачу.
    }
  }

  return hits.slice(0, Math.max(input.limit, 1));
}
