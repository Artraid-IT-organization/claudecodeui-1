/**
 * «Продолжить в новом чате»: выжимка главного из длинного чата, с которой
 * открывается новый чат.
 *
 * Зачем. У долгого чата контекст разрастается до сотен тысяч токенов: ответы
 * медленнее, дороже и хуже («context rot»). Встроенное сжатие продолжает тот
 * же разговор и пишет пересказ «всего подряд». Здесь — наоборот: чистый новый
 * чат и короткая выжимка того, что нужно, чтобы продолжить дело (Егор 23.09.26:
 * «контекст обнулять, но главные мысли пусть остаются… чтобы я сам ничего не
 * переносил»).
 *
 * Откуда устройство выжимки (поиск 23.09.26, ничего своего):
 * - Разделы встроенного сжатия Claude Code: намерение, ошибки и исправления,
 *   все сообщения человека, текущая работа с дословной цитатой, следующий шаг
 *   только в русле просьб человека.
 * - yacb2/claude-session-handoff: каждое утверждение о состоянии — «проверено»
 *   или «со слов»; развилка записывается как развилка, шаг не выдумывается;
 *   переписку в сотни тысяч токенов не заставлять писать выжимку самой себе.
 * - REMvisual/claude-handoff: «что пробовали и не сработало» дороже всего
 *   открывать заново; решения — вместе с отвергнутыми; реальные цифры;
 *   поправки человека; от 500 тыс. токенов — разбор частями (map-reduce).
 * - sidorovanthon/handoff-prompt, aihero /handoff: документы проекта — ссылкой
 *   на путь, не пересказом; пустые разделы опускать.
 * - Anthropic, «Effective context engineering»: держать лёгкие указатели
 *   (пути, запросы) и доставать подробности по требованию.
 *
 * Как устроено. Выжимку пишет отдельный вызов Sonnet по сжатому тексту
 * переписки (handoff-digest.ts), а не сам разросшийся чат: так не платится
 * повторное чтение всего контекста и не нужен лишний ход в старом чате. Шапку
 * и «где искать» сервер пишет сам — это факты, модели их не доверяем.
 * Работа идёт задачей в фоне (модель думает до пары минут, прокси и телефон
 * столько не ждут): кнопка ставит задачу и опрашивает её.
 */
import fs from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import { digestTranscriptFile, type TranscriptDigest } from '@/modules/handoff/handoff-digest.js';
import { canonicalizeAccountDir, getActiveAccountDir } from '@/shared/session-scope.js';

/** Переписка длиннее — разбирается частями, потом части сводятся. */
const SINGLE_PASS_MAX_CHARS = 300_000;
/** Размер одной части при разборе частями (≈ 100 тыс. токенов русского текста). */
const CHUNK_CHARS = 240_000;
/** Сколько частей разбирать одновременно — бережём подписку и сервер. */
const MAP_CONCURRENCY = 2;
/** Самые ранние части сверх этого числа не разбираются: их смысл уже в сводках сжатия. */
const MAX_CHUNKS = 8;
const MODEL_TIMEOUT_MS = 5 * 60 * 1000;
/** Готовая выжимка живёт столько, сколько нужно, чтобы вкладка её забрала. */
const JOB_TTL_MS = 30 * 60 * 1000;
const MODEL_CWD = path.join(os.homedir(), '.cloudcli', 'handoff-cwd');
const TITLE_STUB_MAX_BYTES = 4096;

const BRIEF_RULES = `Правила (собраны из открытых практик передачи дел между сессиями ИИ-агентов):
- Только то, что есть в переписке. Ничего не выдумывай и не додумывай. Не знаешь — не пиши.
- Каждое утверждение о состоянии дел (сделано, работает, выкачено, исправлено, цифра) помечай: «(проверено)» — если в переписке есть проверка делом (снимок, замер, запуск, ответ человека «работает»); «(со слов)» — если только заявлено.
- Более поздние сообщения отменяют более ранние: если решение или просьба менялись, передавай последнее состояние, а отменённое — только как отвергнутое, с причиной.
- Решения — с причиной; отвергнутые варианты тоже, иначе новый чат пойдёт по кругу.
- Что пробовали и что не сработало — самое дорогое открывать заново, не пропускай.
- Поправки, требования и предпочтения человека передавай почти дословно, в кавычках: место, порядок, вид, запреты.
- Файлы, документы, страницы, команды — ссылкой (путь, адрес, команда), без пересказа их содержимого.
- Не переноси секреты: пароли, ключи, токены, ссылки для входа или приглашения — вместо них укажи, где они лежат (путь к файлу), если это видно из переписки.
- Не переноси: ход рассуждений, вывод команд, пустые попытки, которые ничему не учат, общие правила, которые и так записаны в CLAUDE.md или памяти.
- Следующий шаг — только если он прямо следует из просьб человека. Если дальше развилка, опиши её как развилку (варианты и чем отличаются), не выбирай сам. Если дело закончено — так и напиши.
- Пиши на языке переписки, коротко, пунктами, конкретными существительными (пути, имена, числа), без воды. Раздел без содержания опускай вместе с заголовком. Разделительных линий (---) между разделами не ставь.
- Пустых оборотов нет: «важно отметить», «в целом», «ключевой», «является», «осуществлён», «была проделана работа», «обсуждали возможность» (если решили — пиши «решили»), «Таким образом…» в конце. Жирным — только названия и числа, которые ищут глазами.

Образец хорошего пункта (из настоящей выжимки):
- Шрифты PT Serif + PT Sans вместо Cormorant + Montserrat — встроены в macOS; Cormorant давал белёсый текст и кривую вёрстку в Keynote (проверено снимками).
Плохо: «Была проведена работа по подбору шрифтов с учётом пожеланий».`;

/**
 * Опись до текста (Chain of Density; у встроенного сжатия Claude Code — блок
 * <analysis>): модель сначала выписывает из ВСЕЙ переписки, включая конец,
 * имена, числа, решения, поправки — и только потом пишет. Опись вырезается
 * до показа (stripInventory).
 */
const INVENTORY_STEP = `Сначала, в блоке <опись>…</опись>, пройди переписку до самого конца и выпиши коротко: просьбы и цели человека (с их сменой), решения и отказы, поправки человека, числа, имена, названия, пути к файлам, открытые вопросы, последнее, что происходило. Потом напиши выжимку так, чтобы в неё вошло всё из описи, что нужно для продолжения дела; вместо пустых слов — пункты описи. Опись увидит только сервер, человек и новый агент её не увидят.`;

const BRIEF_SECTIONS = `Разделы (заголовки ##, в этом порядке):
## Цель — 1–3 предложения: чего человек добивается и что он должен увидеть в итоге.
## Где остановились — последний запрос человека дословно в кавычках и что агент успел по нему сделать.
## Что сделано — по пунктам, с пометками (проверено)/(со слов).
## Решения — что выбрано и почему; отвергнутое — с причиной.
## Не сработало — что пробовали, почему не вышло.
## Поправки и пожелания человека — почти дословно.
## Цифры и факты — настоящие числа, адреса, имена, версии.
## Ждёт решения человека — открытые вопросы к нему.
## Следующий шаг
## Где искать — пути к файлам, документам, страницам дела и заметкам, которые упоминаются в переписке как источник.`;

function singlePassPrompt(digest: string): string {
  return `Ты готовишь передачу дела. Разговор человека с ИИ-агентом (Claude Code) разросся, и работа продолжится в НОВОМ чате, где у агента этой переписки не будет. Новый агент увидит только твой текст (и при нужде сможет искать в полной переписке по словам). Напиши выжимку, по которой он продолжит без потерь и без переспросов. Объём выжимки — сколько нужно, но не больше ~1500 слов.

${BRIEF_RULES}

${BRIEF_SECTIONS}

${INVENTORY_STEP}

После описи — только выжимка в Markdown, без вступления и без заключения.

Переписка (ЧЕЛОВЕК — сообщения человека, АГЕНТ — ответы агента, строки «·» — его действия):
<transcript>
${digest}
</transcript>`;
}

function mapPrompt(chunk: string, index: number, total: number): string {
  return `Это часть ${index} из ${total} длинной переписки человека с ИИ-агентом (Claude Code), в хронологическом порядке. Позже из заметок по всем частям соберут выжимку для нового чата. Выпиши из ЭТОЙ части всё, что может понадобиться, чтобы продолжить дело: цели и просьбы человека, что сделано (с пометкой (проверено)/(со слов)), решения и отвергнутое с причинами, что не сработало, поправки человека почти дословно, цифры и факты, открытые вопросы, пути к файлам и документам. Указывай дату и время из меток, когда что-то решалось или менялось. Ничего не выдумывай. До ~1200 слов, пунктами, на языке переписки. Верни только заметки.

<transcript part="${index}/${total}">
${chunk}
</transcript>`;
}

function reducePrompt(notes: string[], lastChunk: string): string {
  const joined = notes.map((note, i) => `<notes part="${i + 1}">\n${note}\n</notes>`).join('\n\n');
  return `Ты готовишь передачу дела. Разговор человека с ИИ-агентом (Claude Code) разросся, и работа продолжится в НОВОМ чате, где у агента этой переписки не будет. Переписка очень длинная, поэтому ниже — заметки по её частям в хронологическом порядке, а последняя часть дана целиком. Сведи всё в одну выжимку, по которой новый агент продолжит без потерь. Объём выжимки — сколько нужно, но не больше ~1800 слов.

${BRIEF_RULES}

${BRIEF_SECTIONS}

${INVENTORY_STEP}

После описи — только выжимка в Markdown, без вступления и без заключения.

${joined}

Последняя часть переписки целиком:
<transcript part="last">
${lastChunk}
</transcript>`;
}

/** Убирает опись: она нужна модели, чтобы ничего не потерять, но не читателю. */
function stripInventory(text: string): string {
  const cut = text.replace(/<опись>[\s\S]*?<\/опись>/g, '').trim();
  // Модель не закрыла опись — выжимку всё равно ищем с первого заголовка раздела.
  const firstHeading = cut.search(/^##\s/m);
  if (cut.includes('<опись>') && firstHeading >= 0) return cut.slice(firstHeading).trim();
  return cut;
}

/**
 * Вторая линия защиты от секретов (первая — правило в задании модели):
 * первое сообщение нового чата хранится в переписке и видно на экране, ключам
 * там не место. Убираются ссылки входа с токеном, ключи API вида sk-…/ghp_…,
 * «Bearer …» и JWT; линии «---» между разделами — шум.
 */
function scrubBrief(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s`)]*\/(?:enter|invite|login|auth)\/)[A-Za-z0-9_-]{12,}/g, '$1[скрыто]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/g, '[ключ скрыт]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [скрыто]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[токен скрыт]')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Режет текст на части по границам сообщений, ближе к заданному размеру. */
function splitIntoChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\nЧЕЛОВЕК:', end);
      const altBoundary = text.lastIndexOf('\n\n', end);
      const cut = Math.max(boundary, altBoundary);
      if (cut > start + size / 2) end = cut;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Убирает пустой «чат» из одного заголовка, который CLI оставляет даже без записи разговора. */
async function removeTitleStub(configDir: string, sessionId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  const projectsDir = path.join(configDir, 'projects');
  let dirs: string[] = [];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return;
  }
  await Promise.all(dirs.map(async (dir) => {
    const file = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > TITLE_STUB_MAX_BYTES) return;
      const lines = (await readFile(file, 'utf-8')).split('\n').filter((line) => line.trim());
      const onlyTitles = lines.length > 0 && lines.every((line) => {
        try {
          const type = (JSON.parse(line) as { type?: unknown }).type;
          return type === 'ai-title' || type === 'custom-title';
        } catch {
          return false;
        }
      });
      if (onlyTitles) await unlink(file);
    } catch {
      // Файла нет — убирать нечего.
    }
  }));
}

/**
 * Один ответ модели, как у раскладчика групп: без инструментов, без
 * размышлений, без записи разговора и без чтения настроек (иначе сработали бы
 * хуки), входом того аккаунта, чей это чат.
 */
async function askModelOnce(prompt: string, accountDir: string): Promise<string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = accountDir;
  await mkdir(MODEL_CWD, { recursive: true }).catch(() => undefined);

  const instance = query({
    prompt,
    options: {
      cwd: MODEL_CWD,
      model: 'sonnet',
      tools: [],
      maxTurns: 1,
      thinking: { type: 'disabled' },
      persistSession: false,
      settingSources: [],
      env,
    },
  });

  let resultText = '';
  let errorText = '';
  let sessionId: string | undefined;
  const timer = setTimeout(() => {
    try {
      instance.close?.();
    } catch {
      // Цикл ниже просто закончится.
    }
  }, MODEL_TIMEOUT_MS);
  timer.unref?.();
  try {
    for await (const message of instance as AsyncIterable<Record<string, unknown>>) {
      if (typeof message.session_id === 'string' && !sessionId) sessionId = message.session_id;
      if (message.type === 'result') {
        if (typeof message.result === 'string') resultText = message.result;
        if (message.is_error) errorText = String(message.result ?? message.subtype ?? 'ошибка модели');
      }
    }
  } finally {
    clearTimeout(timer);
    if (sessionId) {
      const id = sessionId;
      await removeTitleStub(accountDir, id);
      setTimeout(() => void removeTitleStub(accountDir, id), 20 * 1000).unref?.();
    }
  }
  if (errorText || !resultText.trim()) {
    throw new Error(errorText || 'модель не ответила');
  }
  return resultText.trim();
}

type Ask = (prompt: string, accountDir: string) => Promise<string>;

/**
 * Пишет выжимку: одним вызовом или частями со сводкой. Выставлена для тестов
 * этого модуля (разбор частями проверяется подставной моделью).
 */
export async function writeBrief(digest: string, accountDir: string, ask: Ask = askModelOnce): Promise<string> {
  if (digest.length <= SINGLE_PASS_MAX_CHARS) {
    return scrubBrief(stripInventory(await ask(singlePassPrompt(digest), accountDir)));
  }
  const chunks = splitIntoChunks(digest, CHUNK_CHARS).slice(-MAX_CHUNKS);
  const lastChunk = chunks[chunks.length - 1];
  const earlier = chunks.slice(0, -1);
  const notes: string[] = new Array(earlier.length);
  let next = 0;
  const worker = async () => {
    while (next < earlier.length) {
      const index = next++;
      notes[index] = await ask(mapPrompt(earlier[index], index + 1, chunks.length), accountDir);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAP_CONCURRENCY, earlier.length) }, worker));
  return scrubBrief(stripInventory(await ask(reducePrompt(notes, lastChunk), accountDir)));
}

type HandoffSource = {
  sessionId: string;
  title: string;
  projectPath: string | null;
  transcriptPath: string;
  providerSessionId: string | null;
  accountDir: string;
};

/** Первое сообщение нового чата: выжимка модели между шапкой и указателями, которые пишет сервер. */
function composeMessage(source: HandoffSource, digest: TranscriptDigest, brief: string, now: Date): string {
  const date = now.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
  const lines = [
    `↪ Продолжение чата «${source.title}»`,
    '',
    `Это перенос дела из прошлого чата (${date}): там разросся контекст, поэтому работа продолжается здесь с чистого листа. Ниже — выжимка главного, её собрал сайт по переписке.`,
    '',
    brief,
    '',
    '## Прошлый чат',
    `- Полная переписка прошлого чата: \`${source.transcriptPath}\`. Целиком не читай — ищи нужное по словам (grep), когда в выжимке не хватает деталей.`,
  ];
  if (source.projectPath) lines.push(`- Папка, в которой шёл чат: \`${source.projectPath}\``);
  if (digest.changedFiles.length > 0) {
    lines.push(`- Файлы, которые менялись в прошлом чате (свежие сверху): ${digest.changedFiles.map((file) => `\`${file}\``).join(', ')}`);
  }
  lines.push(
    '',
    'Сейчас ничего не делай. Ответь в 3–5 строк: как понял дело, где остановились и какой следующий шаг, — и жди сообщения.',
  );
  return lines.join('\n');
}

/** Путь к переписке чата — только внутри папки аккаунта того, кто нажал кнопку. */
async function resolveSource(sessionId: string): Promise<HandoffSource> {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row) throw new HandoffError(404, 'чат не найден');
  if (row.provider && row.provider !== 'claude') throw new HandoffError(400, 'перенос пока умеет только чаты Claude');

  const accountDir = getActiveAccountDir();
  const projectsRoot = path.join(accountDir, 'projects') + path.sep;
  const providerSessionId = row.provider_session_id || row.session_id;

  let transcriptPath = row.jsonl_path || null;
  if (!transcriptPath && /^[0-9a-f-]{36}$/i.test(providerSessionId)) {
    const dirs = await readdir(path.join(accountDir, 'projects')).catch(() => [] as string[]);
    for (const dir of dirs) {
      const candidate = path.join(accountDir, 'projects', dir, `${providerSessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        transcriptPath = candidate;
        break;
      }
    }
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    throw new HandoffError(404, 'в чате ещё нет ни одного ответа — дождитесь первого и нажмите снова');
  }
  // Чужой чат не прочитать: файл обязан лежать в папке аккаунта запроса.
  const realTranscript = canonicalizeAccountDir(transcriptPath);
  if (!realTranscript.startsWith(projectsRoot)) {
    throw new HandoffError(403, 'чат другого аккаунта');
  }

  return {
    sessionId,
    title: (row.custom_name || '').trim() || 'без названия',
    projectPath: row.project_path,
    transcriptPath: realTranscript,
    providerSessionId,
    accountDir,
  };
}

/** Ошибка с кодом ответа — чтобы маршрут не гадал, что сказать вкладке. */
export class HandoffError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** Состояние задачи «собрать выжимку» — его опрашивает кнопка. */
export type HandoffJob = {
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  /** Готовое первое сообщение нового чата. */
  message?: string;
  error?: string;
  /** Папка, в которой открыть новый чат (та же, что у прошлого). */
  projectPath?: string | null;
};

const jobs = new Map<string, HandoffJob>();

function jobKey(accountDir: string, sessionId: string): string {
  return `${accountDir}::${sessionId}`;
}

function sweepJobs(): void {
  const now = Date.now();
  for (const [key, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(key);
  }
}

/**
 * Ставит задачу собрать выжимку чата (handoff.routes.ts). Повторное нажатие,
 * пока идёт прежняя, возвращает её же — второй вызов модели не начинается.
 */
export async function startHandoff(sessionId: string, ask: Ask = askModelOnce): Promise<HandoffJob> {
  sweepJobs();
  const source = await resolveSource(sessionId);
  const key = jobKey(source.accountDir, sessionId);
  const existing = jobs.get(key);
  if (existing?.status === 'running') return existing;

  const job: HandoffJob = { status: 'running', startedAt: Date.now(), projectPath: source.projectPath };
  jobs.set(key, job);
  void (async () => {
    try {
      const digest = await digestTranscriptFile(source.transcriptPath, source.providerSessionId);
      if (!digest.text.trim()) throw new Error('в переписке нет сообщений');
      const brief = await writeBrief(digest.text, source.accountDir, ask);
      job.message = composeMessage(source, digest, brief, new Date());
      job.status = 'done';
      console.log(`[handoff] ${sessionId}: выжимка ${job.message.length} зн. из ${digest.text.length} зн. переписки за ${Math.round((Date.now() - job.startedAt) / 1000)} с`);
    } catch (error) {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
      console.error(`[handoff] ${sessionId}: не удалось собрать выжимку:`, job.error);
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job;
}

/** Текущее состояние задачи чата для аккаунта запроса (handoff.routes.ts). */
export function getHandoff(sessionId: string): HandoffJob | null {
  sweepJobs();
  return jobs.get(jobKey(getActiveAccountDir(), sessionId)) ?? null;
}
