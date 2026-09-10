/**
 * Пресеты промптов: сохранённые «системные заготовки», которые пользователь
 * переключает в шапке разговора.
 *
 * Смысл. Один и тот же человек за день переходит между разными ролями: «ревью
 * кода» — коротко, без болтовни; «объясни как школьнику» — многословно и с
 * примерами; «разбор ошибки» — методично, вопрос за вопросом. Раньше на каждую
 * роль приходилось нести системный промпт заново копипастом из документа.
 * Пресет — это готовая заготовка: имя, системный промпт, модель по умолчанию.
 * Одно нажатие в шапке — и разговор идёт в новом стиле.
 *
 * Данные лежат у пользователя, а не глобально: у каждого своя коллекция. Если
 * пресетов ноль — на первом запросе создаём три предустановленных, чтобы было
 * от чего оттолкнуться, а не пустой список.
 */
import { getConnection } from '@/modules/database/connection.js';

export type PromptPreset = {
  id: number;
  userId: number;
  name: string;
  /** Системный промпт: то, что уходит модели как system-инструкция. */
  systemPrompt: string;
  /** Модель по умолчанию для этого пресета. null — оставить текущий выбор. */
  defaultModel: string | null;
  /** Сортировка вручную: чем меньше — тем выше в списке. */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

// Три пресета «из коробки»: не про Клода конкретно, а про универсальные роли,
// которые пригодятся любому. Пользователь их видит на первом запросе и может
// править как обычные, никак не отмечены как системные.
const SEED_PRESETS: Array<Pick<PromptPreset, 'name' | 'systemPrompt' | 'defaultModel'>> = [
  {
    name: 'Ревью кода',
    systemPrompt:
      'Ты старший инженер, делающий ревью. Отвечай коротко и по делу, без болтовни. Показывай проблемы блоками: что не так, почему это плохо, как поправить. Одна конкретная правка за раз.',
    defaultModel: null,
  },
  {
    name: 'Объясни как школьнику',
    systemPrompt:
      'Объясняй так, чтобы понял человек без технического образования. Используй знакомые аналогии из быта. Не бойся повторить главное дважды, если это поможет понять. Спрашивай, где непонятно.',
    defaultModel: null,
  },
  {
    name: 'Разбор ошибки',
    systemPrompt:
      'Разбирай ошибку методично: сначала выясни симптом (что именно происходит), потом причину (почему), потом варианты решения — от простого к сложному. Не спеши предлагать первое пришедшее в голову. Задай уточняющие вопросы, если не хватает данных.',
    defaultModel: null,
  },
];

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS prompt_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    default_model TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`;

type PromptPresetRow = {
  id: number;
  user_id: number;
  name: string;
  system_prompt: string;
  default_model: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function toPreset(row: PromptPresetRow): PromptPreset {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    systemPrompt: row.system_prompt,
    defaultModel: row.default_model,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureTable(): void {
  const db = getConnection();
  db.exec(CREATE_TABLE_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_prompt_presets_user_order ON prompt_presets(user_id, sort_order, id)'
  );
}

function seedIfEmpty(userId: number): void {
  const db = getConnection();
  const count = (
    db
      .prepare('SELECT COUNT(*) AS c FROM prompt_presets WHERE user_id = ?')
      .get(userId) as { c: number }
  ).c;
  if (count > 0) return;

  const insert = db.prepare(
    `INSERT INTO prompt_presets (user_id, name, system_prompt, default_model, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  );
  const runInTx = db.transaction(() => {
    SEED_PRESETS.forEach((preset, index) => {
      insert.run(userId, preset.name, preset.systemPrompt, preset.defaultModel, index);
    });
  });
  runInTx();
}

export const promptPresetsDb = {
  /**
   * Возвращает пресеты пользователя. На первом чтении создаёт три пресета «из
   * коробки», чтобы пользователь видел живой список, а не пустоту.
   */
  list(userId: number): PromptPreset[] {
    ensureTable();
    seedIfEmpty(userId);

    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT id, user_id, name, system_prompt, default_model, sort_order, created_at, updated_at
         FROM prompt_presets
         WHERE user_id = ?
         ORDER BY sort_order, id`
      )
      .all(userId) as PromptPresetRow[];
    return rows.map(toPreset);
  },

  get(userId: number, id: number): PromptPreset | null {
    ensureTable();
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT id, user_id, name, system_prompt, default_model, sort_order, created_at, updated_at
         FROM prompt_presets
         WHERE user_id = ? AND id = ?`
      )
      .get(userId, id) as PromptPresetRow | undefined;
    return row ? toPreset(row) : null;
  },

  create(
    userId: number,
    input: { name: string; systemPrompt: string; defaultModel?: string | null }
  ): PromptPreset {
    ensureTable();
    const db = getConnection();

    const maxOrder = (
      db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM prompt_presets WHERE user_id = ?')
        .get(userId) as { m: number }
    ).m;

    const result = db
      .prepare(
        `INSERT INTO prompt_presets (user_id, name, system_prompt, default_model, sort_order)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(userId, input.name.trim(), input.systemPrompt, input.defaultModel ?? null, maxOrder + 1);

    const preset = promptPresetsDb.get(userId, Number(result.lastInsertRowid));
    if (!preset) throw new Error('пресет не сохранился');
    return preset;
  },

  update(
    userId: number,
    id: number,
    input: { name?: string; systemPrompt?: string; defaultModel?: string | null }
  ): PromptPreset | null {
    ensureTable();
    const db = getConnection();

    const existing = promptPresetsDb.get(userId, id);
    if (!existing) return null;

    const next = {
      name: input.name !== undefined ? input.name.trim() : existing.name,
      systemPrompt: input.systemPrompt !== undefined ? input.systemPrompt : existing.systemPrompt,
      defaultModel:
        input.defaultModel !== undefined ? input.defaultModel : existing.defaultModel,
    };

    db.prepare(
      `UPDATE prompt_presets
       SET name = ?, system_prompt = ?, default_model = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND id = ?`
    ).run(next.name, next.systemPrompt, next.defaultModel, userId, id);

    return promptPresetsDb.get(userId, id);
  },

  delete(userId: number, id: number): boolean {
    ensureTable();
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM prompt_presets WHERE user_id = ? AND id = ?')
      .run(userId, id);
    return result.changes > 0;
  },

  /**
   * Меняет порядок пресетов в списке разом. Принимает массив id в желаемом
   * порядке; всё, чего нет в массиве, оседает в конце с сохранением своего
   * относительного порядка.
   */
  reorder(userId: number, orderedIds: number[]): PromptPreset[] {
    ensureTable();
    const db = getConnection();
    const runInTx = db.transaction(() => {
      const update = db.prepare(
        'UPDATE prompt_presets SET sort_order = ? WHERE user_id = ? AND id = ?'
      );
      orderedIds.forEach((id, index) => update.run(index, userId, id));
    });
    runInTx();
    return promptPresetsDb.list(userId);
  },
};
