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
/**
 * Сколько мыслей уходит модели за один вызов. На пачке из 20 Haiku вернула 17
 * ответов (замер 14.09.26) — пачки меньше, ответы сверяются по номеру.
 */
const DIGEST_CHUNK_SIZE = 10;
const MAX_THOUGHT_CHARS = 4000;
const DIGEST_TIMEOUT_MS = 120 * 1000;
/**
 * Столько разборов идёт одновременно, остальные ждут очереди.
 *
 * Каждый разбор — отдельный процесс CLI на ~180 МБ, и он считается в пределы
 * самой службы. 21.09.26 их набралось 43 штуки: страница дозапрашивала разбор
 * на каждую новую мысль прямого эфира, а прежний запрос оставался считаться на
 * сервере. Служба упёрлась в свой потолок памяти, её начало тормозить ядро — и
 * вместе с ней встала выдача страниц, то есть один открытый экран положил
 * интерфейс целиком. Клиент с тех пор не частит (WorkStretchContainer), но
 * потолок здесь нужен всё равно: сервер не должен зависеть от того, как себя
 * ведёт браузер.
 */
const MAX_PARALLEL_DIGESTS = 2;
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

/**
 * Пропускной пункт: больше `limit` работ разом не пускает, остальные стоят в
 * очереди в порядке прихода. Отдельной функцией — чтобы проверять тестом без
 * запуска модели.
 */
export function createGate(limit: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await job();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

/** Один пропускной пункт на всю службу: потолок общий, а не на запрос. */
const gate = createGate(MAX_PARALLEL_DIGESTS);

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

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Ответ действительно про эту мысль: модель повторила её первые слова.
 *
 * Замер 14.09.26 на 40 настоящих мыслях: мысль «сборка идёт в фоне, нужно
 * успеть до перезапуска; проверка не удалась — поле поиска не видно» получила
 * перевод одной второй половины — начало потерялось. При путанице номеров
 * (модель уже пропускала элементы) под мыслью оказался бы и вовсе чужой
 * текст. Поэтому без совпадения первых слов ответ не принимается и мысль
 * уходит на повторный разбор.
 */
export function echoMatches(source: string, echo: unknown): boolean {
  if (typeof echo !== 'string') return false;
  const expected = wordsOf(source).slice(0, 3);
  const got = wordsOf(echo).slice(0, 3);
  if (expected.length === 0 || got.length < Math.min(2, expected.length)) return false;
  return got.every((word, index) => word === expected[index]);
}

/**
 * Разбор ответа модели отдельно от вызова — чтобы проверять тестом.
 *
 * Ответы сверяются по номеру мысли, а не по порядку (модель иногда пропускает
 * или склеивает элементы), и по первым словам исходника (защита от перевода
 * без начала и от путаницы номеров). Не сошлось — `null` на месте мысли, её дошлют ещё раз; совсем не
 * JSON — `null`.
 */
export function parseDigest(raw: string, texts: string[]): Array<ThoughtDigest | null> | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const results: Array<ThoughtDigest | null> = texts.map(() => null);
  for (const item of parsed) {
    const { id, start: echo } = (item ?? {}) as { id?: unknown; start?: unknown };
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= texts.length) continue;
    if (!echoMatches(texts[id], echo)) continue;
    results[id] = readDigest(item);
  }
  return results;
}

export function buildDigestPrompt(texts: string[]): string {
  return [
    'Ниже по порядку — размышления ИИ-помощника во время одной работы, у каждого свой номер id. Человек, который поручил работу, хочет видеть этапы работы, но не рабочие мелочи.',
    '',
    'Для КАЖДОГО фрагмента реши, важный ли это этап.',
    'ВАЖНО (keep: true) — в фрагменте есть содержание, которое человеку стоит знать:',
    '- закончено исследование, разбор или замер, и есть вывод;',
    '- найдена причина, ошибка или неожиданный факт;',
    '- принято решение или изменён план — и почему;',
    '- запущена крупная проверка, критика, ревью или исследование — и что именно проверяется;',
    '- получен итог проверки или критики;',
    '- подведён итог части работы; упёрлись в препятствие.',
    'НЕ ВАЖНО (keep: false):',
    '- пустые реплики без содержания: «готово», «на этом закончил», «есть всё нужное, отвечаю», «можно двигаться дальше»;',
    '- «сейчас прочитаю / посмотрю / запущу X» без причины и без итога; ожидание;',
    '- пересказ команды, справки или синтаксиса; мелкая починка служебного скрипта;',
    '- повтор того, что уже сказано в предыдущих фрагментах.',
    '',
    'Для важных дай русский текст: точный перевод по смыслу, можно чуть короче, без потери сути и без добавлений от себя. Имена файлов, команды, код и названия программ оставляй как есть; имя Egor пиши «Егор». Если фрагмент уже по-русски — верни его как есть.',
    '',
    'Ответь ТОЛЬКО JSON-массивом, по одному элементу на КАЖДЫЙ id, ничего не пропуская и не объединяя. В поле start — первые три слова ЭТОГО фрагмента дословно, на языке оригинала: {"id": 0, "start": "The build is", "keep": true, "ru": "…"} или {"id": 1, "start": "Сначала изучу код", "keep": false}. Без пояснений.',
    '',
    JSON.stringify(texts.map((text, id) => ({ id, text }))),
  ].join('\n');
}

async function askModel(
  texts: string[],
  claudeConfigDir: string | null,
  signal?: AbortSignal,
): Promise<Array<ThoughtDigest | null> | null> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  await mkdir(DIGEST_CWD, { recursive: true }).catch(() => undefined);

  // Отмену несёт свой контроллер: по нему SDK гасит процесс CLI (мягко, затем
  // принудительно). Браузер ушёл со страницы — считать дальше некому и незачем.
  const abort = new AbortController();
  const forwardAbort = () => abort.abort();
  if (signal) {
    if (signal.aborted) return null;
    signal.addEventListener('abort', forwardAbort, { once: true });
  }

  const instance = query({
    prompt: buildDigestPrompt(texts),
    options: {
      abortController: abort,
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
    if (signal) signal.removeEventListener('abort', forwardAbort);
    if (sessionId) {
      const id = sessionId;
      await removeTitleStub(claudeConfigDir, id);
      // Заголовок CLI может дописать уже после ответа — второй заход позже.
      setTimeout(() => void removeTitleStub(claudeConfigDir, id), 20 * 1000).unref?.();
    }
  }

  return parseDigest(resultText, texts);
}

/**
 * Пачка в работе: её ждут все, кто смотрит одни и те же мысли.
 *
 * `waiters` — сколько ждущих осталось. Ушёл последний (человек закрыл страницу,
 * браузер оборвал запрос) — разбор гасится: считать его больше некому.
 */
type DigestBatch = {
  promise: Promise<Array<ThoughtDigest | null> | null>;
  abort: AbortController;
  waiters: number;
};

/** Одна и та же пачка из двух вкладок разбирается одним вызовом. */
const inFlight = new Map<string, DigestBatch>();

function whenAborted(signal: AbortSignal): Promise<null> {
  return new Promise<null>((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener('abort', () => resolve(null), { once: true });
  });
}

async function digestChunk(
  texts: string[],
  claudeConfigDir: string | null,
  signal?: AbortSignal,
): Promise<Array<ThoughtDigest | null> | null> {
  const key = `${claudeConfigDir ?? ''}\n${texts.join('\n \n')}`;
  let batch = inFlight.get(key);
  if (!batch) {
    const abort = new AbortController();
    const started: DigestBatch = { abort, waiters: 0, promise: Promise.resolve(null) };
    started.promise = gate(() => askModel(texts, claudeConfigDir, abort.signal)).finally(() => inFlight.delete(key));
    batch = started;
    inFlight.set(key, started);
  }

  batch.waiters += 1;
  try {
    return await (signal ? Promise.race([batch.promise, whenAborted(signal)]) : batch.promise);
  } finally {
    batch.waiters -= 1;
    // Гасим только брошенную работу; после ответа отмена уже ничего не делает.
    if (batch.waiters <= 0) batch.abort.abort();
  }
}

/**
 * Итог разбора в том же порядке; `null` на месте мысли, которую разобрать не
 * удалось.
 */
export async function digestThoughts(
  rawTexts: unknown,
  claudeConfigDir: string | null,
  signal?: AbortSignal,
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
  // Запрос уже брошен — в модель не идём вовсе: разобранное из кэша отдадим,
  // остальное останется пустым.
  if (signal?.aborted) return results;
  missing.sort((a, b) => a - b);
  await mkdir(CACHE_DIR, { recursive: true }).catch(() => undefined);

  const save = async (index: number, digest: ThoughtDigest) => {
    // Русскую мысль-этап показываем словами автора, а не пересказом модели.
    const final: ThoughtDigest = digest.keep && isMostlyRussian(texts[index])
      ? { keep: true, ru: texts[index] }
      : digest;
    results[index] = final;
    await writeFile(cacheFileFor(texts[index]), JSON.stringify(final), 'utf-8').catch(() => undefined);
  };

  const runChunks = async (indices: number[]): Promise<number[]> => {
    const unresolved: number[] = [];
    for (let start = 0; start < indices.length; start += DIGEST_CHUNK_SIZE) {
      if (signal?.aborted) return unresolved.concat(indices.slice(start)).sort((a, b) => a - b);
      const chunk = indices.slice(start, start + DIGEST_CHUNK_SIZE);
      const digests = await digestChunk(chunk.map((index) => texts[index]), claudeConfigDir, signal);
      await Promise.all(chunk.map(async (index, position) => {
        const digest = digests?.[position] ?? null;
        if (digest) await save(index, digest);
        else unresolved.push(index);
      }));
    }
    return unresolved.sort((a, b) => a - b);
  };

  // Пропущенное моделью досылается ещё раз — отдельной, меньшей пачкой.
  const leftover = await runChunks(missing);
  if (leftover.length > 0 && !signal?.aborted) await runChunks(leftover);
  return results;
}
