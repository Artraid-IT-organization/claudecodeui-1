/**
 * Память проекта: что агент вынес из прошлых разговоров.
 *
 * Задача. Каждый новый разговор начинается с чистого листа: агент заново
 * выясняет, где что лежит, какие тут договорённости и обо что уже спотыкались.
 * Человек пересказывает одно и то же по третьему разу и тратит на это лимит.
 *
 * Что храним. Короткие факты о проекте — по строке-две. Не переписку, не
 * пересказ разговора, а именно выводы: «сборка запускается так-то», «в этой
 * папке трогать нельзя», «порт занят другим ботом». Их пишет человек или сам
 * агент, когда наткнулся на что-то, что пригодится в следующий раз.
 *
 * Почему не векторная база. Соседи (Claude-Flow) держат для этого векторный
 * поиск с индексом HNSW — это оправдано на тысячах записей. Здесь речь о
 * десятках фактов на проект, и обычный текстовый поиск по ним и точнее, и
 * дешевле: ни лишнего процесса, ни индекса, ни памяти под него.
 *
 * Ограничения против разрастания: не больше 200 фактов на проект и не длиннее
 * 500 символов каждый. Всё, что сверху, вытесняет самое старое неиспользуемое.
 */
import { getConnection } from '@/modules/database/index.js';

/** Больше — это уже не память, а свалка: столько в контекст всё равно не влезет. */
const MAX_FACTS_PER_PROJECT = 200;

/** Факт длиннее — это пересказ, а не вывод. */
export const MAX_FACT_LENGTH = 500;

export type ProjectFact = {
  id: number;
  projectPath: string;
  text: string;
  /** Кто записал: 'human' — человек руками, 'agent' — сам агент по ходу работы. */
  source: 'human' | 'agent';
  /** Разговор, в котором факт появился. */
  sessionId: string | null;
  createdAt: string;
  /** Когда факт последний раз попадал в контекст — по нему вытесняем старое. */
  lastUsedAt: string | null;
  useCount: number;
};

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS project_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'human',
    session_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    use_count INTEGER NOT NULL DEFAULT 0
  )
`;

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  const db = getConnection();
  db.exec(CREATE_TABLE_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_project_memory_path ON project_memory(project_path, created_at)',
  );
  // Один и тот же факт дважды не пишем: агент склонен повторяться.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_project_memory_unique ON project_memory(project_path, text)',
  );
  tableReady = true;
}

type FactRow = {
  id: number;
  project_path: string;
  text: string;
  source: string;
  session_id: string | null;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
};

function toFact(row: FactRow): ProjectFact {
  return {
    id: row.id,
    projectPath: row.project_path,
    text: row.text,
    source: row.source === 'agent' ? 'agent' : 'human',
    sessionId: row.session_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

/** Вытесняет лишнее: сначала то, чем ни разу не пользовались и что давнее. */
function enforceLimit(projectPath: string): void {
  const db = getConnection();
  const total = (
    db
      .prepare('SELECT COUNT(*) AS c FROM project_memory WHERE project_path = ?')
      .get(projectPath) as { c: number }
  ).c;
  if (total <= MAX_FACTS_PER_PROJECT) return;

  db.prepare(
    `DELETE FROM project_memory
     WHERE id IN (
       SELECT id FROM project_memory
       WHERE project_path = ?
       ORDER BY use_count, COALESCE(last_used_at, created_at)
       LIMIT ?
     )`,
  ).run(projectPath, total - MAX_FACTS_PER_PROJECT);
}

export const projectMemory = {
  /** Все факты проекта, свежие сверху. */
  list(projectPath: string): ProjectFact[] {
    ensureTable();
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT id, project_path, text, source, session_id, created_at, last_used_at, use_count
         FROM project_memory
         WHERE project_path = ?
         ORDER BY created_at DESC`,
      )
      .all(projectPath) as FactRow[];
    return rows.map(toFact);
  },

  /**
   * Записывает факт. Повтор того же текста не создаёт дубликат — просто
   * освежает существующую запись.
   */
  remember(input: {
    projectPath: string;
    text: string;
    source?: 'human' | 'agent';
    sessionId?: string | null;
  }): ProjectFact | null {
    ensureTable();

    const text = input.text.trim();
    if (!text) return null;
    if (text.length > MAX_FACT_LENGTH) {
      throw new Error(`факт длиннее ${MAX_FACT_LENGTH} символов — это уже пересказ, а не вывод`);
    }

    const db = getConnection();
    db.prepare(
      `INSERT INTO project_memory (project_path, text, source, session_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_path, text) DO UPDATE SET
         session_id = excluded.session_id,
         created_at = CURRENT_TIMESTAMP`,
    ).run(input.projectPath, text, input.source ?? 'human', input.sessionId ?? null);

    enforceLimit(input.projectPath);

    const row = db
      .prepare(
        `SELECT id, project_path, text, source, session_id, created_at, last_used_at, use_count
         FROM project_memory WHERE project_path = ? AND text = ?`,
      )
      .get(input.projectPath, text) as FactRow | undefined;
    return row ? toFact(row) : null;
  },

  forget(projectPath: string, id: number): boolean {
    ensureTable();
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM project_memory WHERE project_path = ? AND id = ?')
      .run(projectPath, id);
    return result.changes > 0;
  },

  /**
   * Готовит кусок текста для системного промпта.
   *
   * Возвращает пустую строку, если фактов нет — тогда в промпт ничего не
   * добавляется и всё работает ровно как раньше. Заодно отмечает факты
   * использованными, чтобы вытеснение выбрасывало действительно ненужное.
   */
  buildContextBlock(projectPath: string, limit = 40): string {
    ensureTable();
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT id, project_path, text, source, session_id, created_at, last_used_at, use_count
         FROM project_memory
         WHERE project_path = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectPath, limit) as FactRow[];

    if (rows.length === 0) return '';

    const ids = rows.map((row) => row.id);
    db.prepare(
      `UPDATE project_memory
       SET use_count = use_count + 1, last_used_at = CURRENT_TIMESTAMP
       WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).run(...ids);

    const lines = rows.map((row) => `- ${row.text}`);
    return [
      'Что уже известно про этот проект из прошлых разговоров:',
      ...lines,
      '',
      'Это накопленные заметки, а не приказ. Если увидишь, что заметка устарела и',
      'противоречит тому, что сейчас в коде, — верь коду и скажи об этом человеку.',
    ].join('\n');
  },
};
