/**
 * Сохранённые промпты для быстрой вставки в поле ввода.
 *
 * Зачем. Егор часто начинает чат одним и тем же длинным текстом («Разбор
 * задачи» перед ссылкой на YouGile, инструкция проекта «Промпты»). Набирать
 * их заново не надо: в шапке разговора есть список, клик вставляет текст в
 * поле — дальше человек дописывает своё (ссылку, уточнение) и отправляет.
 *
 * Хранение. Файл `saved-prompts.json` рядом с базой данных инстанса
 * (каталог `dirname(DATABASE_PATH)`, для общего сайта это
 * `~/.cloudcli-shared/`). У каждого инстанса свой список. Файл правится
 * вручную — «добавь промпт X» делается одной правкой, без пересборки:
 * список перечитывается на каждый запрос.
 *
 * Формат файла:
 *   { "prompts": [ { "name": "Разбор задачи", "text": "…" } ] }
 * Допускается и просто массив [{ "name": …, "text": … }].
 * Строки без непустого имени или текста пропускаются.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getDatabasePath } from '@/modules/database/index.js';

export type SavedPrompt = {
  name: string;
  text: string;
};

const FILE_NAME = 'saved-prompts.json';

function promptsFilePath(): string {
  return path.join(path.dirname(getDatabasePath()), FILE_NAME);
}

function asSavedPrompt(value: unknown): SavedPrompt | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const text = typeof record.text === 'string' ? record.text : '';
  if (!name || !text.trim()) return null;
  return { name, text };
}

// Читаем файл заново на каждый запрос: промптов мало, а правка файла
// подхватывается сразу — без перезапуска сайта.
export function listSavedPrompts(): SavedPrompt[] {
  let raw: string;
  try {
    raw = fs.readFileSync(promptsFilePath(), 'utf8');
  } catch {
    // Файла нет — значит список просто не завели; это не ошибка сайта.
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const entries = Array.isArray(parsed)
      ? parsed
      : (parsed as { prompts?: unknown })?.prompts;
    if (!Array.isArray(entries)) return [];
    return entries.map(asSavedPrompt).filter((p): p is SavedPrompt => p !== null);
  } catch (error) {
    console.error(`[saved-prompts] не разобран ${promptsFilePath()}:`, error);
    return [];
  }
}
