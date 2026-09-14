/**
 * Разбор мыслей «Хода работы»: какие из них — важные этапы, и их русский текст.
 *
 * Как пришли к этому:
 * - 13.09.26 Егор на ленту из всех размышлений подряд: «слишком много лишнего».
 * - 14.09 ограничили показ тремя последними и перевели на русский (модель
 *   размышляет по-английски — «он так умнее, а результаты пусть показываются
 *   на русском»).
 * - 14.09 Егор против потолка: «если он думал несколько часов, пусть распишет
 *   каждый пункт, который важный, ценный — этап какой-то, research закончил,
 *   критику запустил. Это я хочу видеть. До этого он писал абсолютно всё».
 *
 * Важность — вопрос смысла, длина её не ловит (отбор по длине 13.09 дал стену
 * из 22 абзацев). Поэтому одна дешёвая модель за один проход решает «этап или
 * рабочая мелочь» и переводит этапы на русский.
 *
 * Как устроено и почему так:
 * - Разбираются только мысли свёртки, которую человек раскрыл; каждая — один
 *   раз: итог лежит в файле под хэшем текста, повторное открытие подписку не
 *   тратит.
 * - Мысли идут пачками по порядку: модели нужен ход работы, чтобы отличить
 *   этап от повтора.
 * - Haiku без размышлений и инструментов, входом того, кто смотрит, без
 *   записи разговора и без чтения настроек с диска (`settingSources: []`):
 *   иначе на каждый вызов срабатывали бы хуки и CLAUDE.md.
 * - Не вышло — `null` на месте мысли, и показ оставляет её как есть: мысль не
 *   пропадает.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

/** Сколько мыслей принимается за один запрос; длинную работу клиент шлёт страницами. */
export const MAX_THOUGHTS_PER_REQUEST = 60;
/** Сколько мыслей уходит модели за один вызов. */
const DIGEST_CHUNK_SIZE = 20;
const MAX_THOUGHT_CHARS = 4000;
const DIGEST_TIMEOUT_MS = 120 * 1000;
const CACHE_DIR = path.join(os.homedir(), '.cloudcli', 'thought-digests');
/** Своя папка запуска: не общая /tmp, где лежат записи других разговоров. */
const DIGEST_CWD = path.join(os.homedir(), '.cloudcli', 'thought-translate-cwd');
/** Пустышка с заголовком весит сотню байт; всё крупнее — не трогаем. */
const TITLE_STUB_MAX_BYTES = 4096;

export type ThoughtDigest = {
  /** Важный этап, который человеку стоит видеть. */
  keep: boolean;
  /** Русский текст этапа; для мелочи — null. */
  ru: string | null;
};

/**
 * Файл разговора, в котором нет ничего, кроме служебного заголовка.
 *
 * `persistSession: false` не мешает CLI дописать строку `ai-title` в файл
 * разговора (замер 14.09.26: 128 байт в ~/.claude/projects/-tmp/). Отключить
 * это нечем, поэтому такую пустышку убираем за собой — но только если в ней
 * действительно одни заголовки: настоящий разговор удалять нельзя.
 */
export function isTitleStubOnly(content: string): boolean {
  const lines = content.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return false;
  return lines.every((line) => {
    try {
      const type = (JSON.parse(line) as { type?: unknown }).type;
      return type === 'ai-title' || type === 'custom-title';
    } catch {
      return false;
    }
  });
}

async function removeTitleStub(claudeConfigDir: string | null, sessionId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  const configDir = claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const projectsDir = path.join(configDir, 'projects');
  let projectDirs: string[] = [];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return;
  }
  await Promise.all(projectDirs.map(async (dirName) => {
    const file = path.join(projectsDir, dirName, `${sessionId}.jsonl`);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > TITLE_STUB_MAX_BYTES) return;
      if (isTitleStubOnly(await readFile(file, 'utf-8'))) await unlink(file);
    } catch {
      // Файла нет — убирать нечего.
    }
  }));
}

function cacheFileFor(text: string): string {
  return path.join(CACHE_DIR, `${createHash('sha256').update(text).digest('hex')}.json`);
}

export function isMostlyRussian(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const cyrillic = letters.filter((ch) => /[Ѐ-ӿ]/.test(ch)).length;
  return cyrillic / letters.length >= 0.5;
}

function readDigest(value: unknown): ThoughtDigest | null {
  if (!value || typeof value !== 'object') return null;
  const { keep, ru } = value as { keep?: unknown; ru?: unknown };
  if (typeof keep !== 'boolean') return null;
  if (!keep) return { keep: false, ru: null };
  if (typeof ru !== 'string' || !ru.trim()) return null;
  return { keep: true, ru: ru.trim() };
}

/** Разбор ответа модели отдельно от вызова — чтобы проверять тестом. */
export function parseDigest(raw: string, expected: number): ThoughtDigest[] | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== expected) return null;
    const items = parsed.map(readDigest);
    return items.every(Boolean) ? (items as ThoughtDigest[]) : null;
  } catch {
    return null;
  }
}

export function buildDigestPrompt(texts: string[]): string {
  return [
    'Ниже по порядку — размышления ИИ-помощника во время одной работы. Человеку, который поручил работу, нужно видеть этапы, но не рабочие мелочи.',
    '',
    'Для КАЖДОГО фрагмента реши, важный ли это этап:',
    '- ВАЖНО (keep: true): закончено исследование или разбор и есть вывод; найдена причина, ошибка или неожиданный факт; принято решение или изменён план и почему; запущена или получена проверка, критика, ревью, замер — и что вышло; подведён итог части работы; упёрлись в препятствие.',
    '- НЕ ВАЖНО (keep: false): что сейчас прочитать, открыть или запустить без вывода; ожидание; пересказ команды; повтор уже сказанного; мелкие технические шаги.',
    '',
    'Для важных дай русский текст: точный перевод по смыслу, можно чуть короче, но без потери сути. Имена файлов, команды, код и названия программ оставляй как есть. Если фрагмент уже по-русски — верни его как есть.',
    '',
    `Ответь ТОЛЬКО JSON-массивом из ${texts.length} элементов в том же порядке: {"keep": true, "ru": "…"} или {"keep": false}. Без пояснений.`,
    '',
    JSON.stringify(texts),
  ].join('\n');
}

async function askModel(texts: string[], claudeConfigDir: string | null): Promise<ThoughtDigest[] | null> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  await mkdir(DIGEST_CWD, { recursive: true }).catch(() => undefined);

  const instance = query({
    prompt: buildDigestPrompt(texts),
    options: {
      cwd: DIGEST_CWD,
      model: 'haiku',
      tools: [],
      maxTurns: 1,
      thinking: { type: 'disabled' },
      persistSession: false,
      settingSources: [],
      env,
    },
  });

  let resultText = '';
  let sessionId: string | undefined;
  const timer = setTimeout(() => {
    try {
      instance.close?.();
    } catch {
      // Цикл ниже просто закончится.
    }
  }, DIGEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    for await (const message of instance as AsyncIterable<Record<string, unknown>>) {
      if (typeof message.session_id === 'string' && !sessionId) {
        sessionId = message.session_id;
      }
      if (message.type === 'result' && typeof message.result === 'string') {
        resultText = message.result;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (sessionId) {
      const id = sessionId;
      await removeTitleStub(claudeConfigDir, id);
      // Заголовок CLI может дописать уже после ответа — второй заход позже.
      setTimeout(() => void removeTitleStub(claudeConfigDir, id), 20 * 1000).unref?.();
    }
  }

  return parseDigest(resultText, texts.length);
}

/** Одна и та же пачка из двух вкладок разбирается одним вызовом. */
const inFlight = new Map<string, Promise<ThoughtDigest[] | null>>();

async function digestChunk(texts: string[], claudeConfigDir: string | null): Promise<ThoughtDigest[] | null> {
  const key = `${claudeConfigDir ?? ''}\n${texts.join('\n \n')}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = askModel(texts, claudeConfigDir).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/**
 * Итог разбора в том же порядке; `null` на месте мысли, которую разобрать не
 * удалось.
 */
export async function digestThoughts(
  rawTexts: unknown,
  claudeConfigDir: string | null,
): Promise<Array<ThoughtDigest | null>> {
  const texts = (Array.isArray(rawTexts) ? rawTexts : [])
    .slice(0, MAX_THOUGHTS_PER_REQUEST)
    .map((item) => (typeof item === 'string' ? item.slice(0, MAX_THOUGHT_CHARS) : ''));

  const results: Array<ThoughtDigest | null> = texts.map(() => null);
  const missing: number[] = [];

  await Promise.all(texts.map(async (text, index) => {
    if (!text.trim()) return;
    try {
      results[index] = readDigest(JSON.parse(await readFile(cacheFileFor(text), 'utf-8')));
    } catch {
      // Ещё не разбирали.
    }
    if (results[index] === null) missing.push(index);
  }));

  if (missing.length === 0) return results;
  missing.sort((a, b) => a - b);
  await mkdir(CACHE_DIR, { recursive: true }).catch(() => undefined);

  for (let start = 0; start < missing.length; start += DIGEST_CHUNK_SIZE) {
    const chunk = missing.slice(start, start + DIGEST_CHUNK_SIZE);
    const digests = await digestChunk(chunk.map((index) => texts[index]), claudeConfigDir);
    if (!digests) continue;
    await Promise.all(chunk.map(async (index, position) => {
      const digest = digests[position];
      // Русскую мысль показываем своими словами автора, а не пересказом модели.
      const final: ThoughtDigest = digest.keep && isMostlyRussian(texts[index])
        ? { keep: true, ru: texts[index] }
        : digest;
      results[index] = final;
      await writeFile(cacheFileFor(texts[index]), JSON.stringify(final), 'utf-8').catch(() => undefined);
    }));
  }
  return results;
}
