import fsSync, { type Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { devinConnectionsDb, sessionsDb } from '@/modules/database/index.js';
import { readDevinTokenUsage } from '@/modules/providers/list/devin/devin-usage.js';
import { resolveClaudeContextWindow } from '@/modules/providers/services/claude-context-window.js';
import type { AnyRecord } from '@/shared/types.js';
import {
  AppError,
  getOpenCodeDatabasePath,
  readCodexContextTokenUsage,
} from '@/shared/utils.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  getSessionByProviderSessionId?: (providerSessionId: string) => SessionRow | null | undefined;
  getHomeDirectory: () => string;
  getOpenCodeDatabasePath: () => string;
  fileExists: (filePath: string) => boolean;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  readTextFile: (filePath: string) => Promise<string>;
  getClaudeContextWindow: () => string | undefined;
  resolveClaudeContextWindow: typeof resolveClaudeContextWindow;
  readDevinTokenUsage: typeof readDevinTokenUsage;
};

type TokenUsageResult = {
  used: number;
  total?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: {
    input: number;
    output: number;
  };
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  model?: string | null;
  session?: {
    inputTokens: number;
    outputTokens: number;
    freshInputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalTokens: number;
    requests: number;
  };
  unsupported?: boolean;
  message?: string;
};

type OpenCodeTokenRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  getSessionByProviderSessionId: (providerSessionId) => sessionsDb.getSessionByProviderSessionId(providerSessionId),
  getHomeDirectory: () => os.homedir(),
  getOpenCodeDatabasePath,
  fileExists: (filePath) => fsSync.existsSync(filePath),
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
  getClaudeContextWindow: () => process.env.CONTEXT_WINDOW,
  resolveClaudeContextWindow,
  readDevinTokenUsage,
};

function readUsageNumber(value: unknown): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

async function findCodexSessionFile(
  directoryPath: string,
  providerSessionId: string,
  dependencies: ProviderTokenUsageServiceDependencies,
): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await dependencies.readDirectory(directoryPath);
  } catch {
    // Codex session folders are date-partitioned and can disappear while a
    // cleanup is running. An unreadable branch is simply not a match.
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionFile(entryPath, providerSessionId, dependencies);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      return entryPath;
    }
  }

  return null;
}

function readCodexTokenUsage(fileContent: string): TokenUsageResult {
  const lines = fileContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const tokenInfo = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
        ? entry.payload.info
        : null;
      if (!tokenInfo) {
        continue;
      }

      const tokenUsage = readCodexContextTokenUsage(tokenInfo);
      if (tokenUsage) {
        return tokenUsage;
      }
    } catch {
      // A provider may be writing the last JSONL line while this read happens.
    }
  }

  return {
    used: 0,
    total: 200_000,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
  };
}

/**
 * Счётчик токенов чата Claude по файлу переписки. Правила взяты у готовых
 * инструментов, а не придуманы:
 *
 * — Заполненность контекста — последний ответ ОСНОВНОЙ ветки:
 *   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, без
 *   вывода. Так считает сам Claude Code (документация строки состояния:
 *   «used_percentage is calculated from input tokens only»), ccstatusline
 *   (jsonl-metrics.ts: `isMainChain = !isSidechain && !isApiErrorMessage`) и
 *   основной claudecodeui (пропуск помощников и `<synthetic>` с нулевым счётом).
 *   После сжатия разговора (`compact_boundary`) до первого нового ответа —
 *   `compactMetadata.postTokens`, как у ccstatusline.
 * — Полный расход за чат — сумма всех ответов. Claude Code пишет один ответ
 *   несколькими строками с одним `message.id` + `requestId`, и ранние строки
 *   несут недописанный счёт вывода. Склейка по этой паре с максимумом по каждому
 *   полю — как в ccusage (Rust, should_replace_deduped_entry) и tokscale.
 *
 * Файл дочитывается с места прошлого чтения: у долгих чатов он до 90 МБ, а
 * счётчик спрашивают на каждое открытие чата и каждое окно «Token Usage».
 */

type UsageParts = { input: number; output: number; cacheRead: number; cacheCreation: number };

type ClaudeScanState = {
  size: number;
  mtimeMs: number;
  offset: number;
  /** true, когда дочитали файл до конца — `session.*` итоги полные. */
  complete: boolean;
  pending: string;
  requests: Map<string, UsageParts>;
  totals: UsageParts;
  lastMain: (UsageParts & { model: string | null }) | null;
  compactPostTokens: number | null;
  maxObservedContext: number;
  model: string | null;
};

const scanStates = new Map<string, ClaudeScanState>();
const SCAN_STATE_LIMIT = 64;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

// Запрос счётчика больше не ждёт разбор всей стенограммы: у чатов в десятки
// мегабайт первый проход занимал 8–10 с однопоточного процессора, и на это
// время вставала вся очередь запросов сайта (замер 14.10.26: 98 МБ → 10,1 с).
// Кнопке у поля ввода нужны только последний счёт и модель — они читаются с
// конца файла за десятки миллисекунд. Файлы меньше порога разбираются сразу
// целиком (как раньше), большие отдают быстрый ответ без `session`-итогов, а
// полный разбор догоняет в фоне и кладётся в тот же кэш для следующих запросов.
const TAIL_ANSWER_MIN_FILE_BYTES = 4 * 1024 * 1024;
const TAIL_SCAN_CHUNK_BYTES = 1 * 1024 * 1024;
const TAIL_SCAN_MAX_BYTES = 24 * 1024 * 1024;

/** Полный разбор одного файла идёт в единственном экземпляре. */
const runningFullScans = new Map<string, Promise<ClaudeScanState>>();

function emptyParts(): UsageParts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function newScanState(): ClaudeScanState {
  return {
    size: 0,
    mtimeMs: 0,
    offset: 0,
    complete: false,
    pending: '',
    requests: new Map(),
    totals: emptyParts(),
    lastMain: null,
    compactPostTokens: null,
    maxObservedContext: 0,
    model: null,
  };
}

function readUsageParts(usage: AnyRecord): UsageParts {
  return {
    input: readUsageNumber(usage.input_tokens ?? usage.inputTokens),
    output: readUsageNumber(usage.output_tokens ?? usage.outputTokens),
    cacheRead: readUsageNumber(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
    ),
    cacheCreation: readUsageNumber(
      usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens,
    ),
  };
}

function contextOf(parts: UsageParts): number {
  return parts.input + parts.cacheRead + parts.cacheCreation;
}

function applyClaudeLine(state: ClaudeScanState, line: string): void {
  if (!line || (!line.includes('"usage"') && !line.includes('compact_boundary'))) return;
  let entry: AnyRecord;
  try {
    entry = JSON.parse(line) as AnyRecord;
  } catch {
    return;
  }

  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    const meta = entry.compactMetadata ?? {};
    const post = readUsageNumber(meta.postTokens ?? meta.post_tokens);
    state.compactPostTokens = post > 0 ? post : 0;
    state.maxObservedContext = Math.max(state.maxObservedContext, readUsageNumber(meta.preTokens ?? meta.pre_tokens));
    return;
  }

  const usage = entry.type === 'assistant' ? entry.message?.usage : null;
  if (!usage || typeof usage !== 'object') return;

  const parts = readUsageParts(usage as AnyRecord);
  const model = typeof entry.message?.model === 'string' ? entry.message.model : null;
  const isEmpty = parts.input + parts.output + parts.cacheRead + parts.cacheCreation === 0;

  // Полный расход: склейка строк одного ответа, максимум по каждому полю.
  const messageId = typeof entry.message?.id === 'string' ? entry.message.id : '';
  const requestId = typeof entry.requestId === 'string' ? entry.requestId : '';
  const key = messageId && requestId ? `${messageId}:${requestId}` : String(entry.uuid ?? `${state.offset}:${state.requests.size}`);
  if (!isEmpty) {
    const prev = state.requests.get(key) ?? emptyParts();
    const next: UsageParts = {
      input: Math.max(prev.input, parts.input),
      output: Math.max(prev.output, parts.output),
      cacheRead: Math.max(prev.cacheRead, parts.cacheRead),
      cacheCreation: Math.max(prev.cacheCreation, parts.cacheCreation),
    };
    state.totals.input += next.input - prev.input;
    state.totals.output += next.output - prev.output;
    state.totals.cacheRead += next.cacheRead - prev.cacheRead;
    state.totals.cacheCreation += next.cacheCreation - prev.cacheCreation;
    state.requests.set(key, next);
  }

  // Заполненность: только основная ветка, без ошибок API и пустых `<synthetic>`.
  const isMainChain = entry.isSidechain !== true && !entry.isApiErrorMessage && model !== '<synthetic>';
  if (isMainChain && !isEmpty && contextOf(parts) > 0) {
    state.lastMain = { ...parts, model };
    state.compactPostTokens = null;
    state.maxObservedContext = Math.max(state.maxObservedContext, contextOf(parts));
    if (model) state.model = model;
  }
}

async function scanClaudeTranscript(filePath: string): Promise<ClaudeScanState> {
  const stat = await fsp.stat(filePath);
  let state = scanStates.get(filePath);
  // Файл переписали или урезали (например, откат чата) — считаем заново.
  if (!state || stat.size < state.size || (stat.size === state.size && stat.mtimeMs !== state.mtimeMs)) {
    state = newScanState();
  }
  if (stat.size > state.offset) {
    const handle = await fsp.open(filePath, 'r');
    try {
      while (state.offset < stat.size) {
        const length = Math.min(SCAN_CHUNK_BYTES, stat.size - state.offset);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
        if (bytesRead <= 0) break;
        // Кусок режется по последнему переводу строки: многобайтные буквы и
        // недописанная последняя строка остаются в `pending` до следующего раза.
        let chunk = buffer.subarray(0, bytesRead);
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline === -1) {
          state.pending += chunk.toString('utf8');
          state.offset += bytesRead;
          continue;
        }
        const tail = chunk.subarray(lastNewline + 1);
        chunk = chunk.subarray(0, lastNewline);
        const text = state.pending + chunk.toString('utf8');
        state.pending = tail.toString('utf8');
        state.offset += bytesRead;
        for (const line of text.split('\n')) applyClaudeLine(state, line);
        // Между кусками отдаём событийный цикл: без уступки полный разбор
        // многомегабайтной стенограммы — один сплошной CPU-блок на десятки
        // секунд, в который встают все прочие запросы сайта.
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      await handle.close();
    }
  }
  state.size = stat.size;
  state.mtimeMs = stat.mtimeMs;
  if (state.offset >= stat.size) {
    state.complete = true;
  }
  scanStates.delete(filePath);
  scanStates.set(filePath, state);
  if (scanStates.size > SCAN_STATE_LIMIT) {
    const oldest = scanStates.keys().next().value;
    if (oldest) scanStates.delete(oldest);
  }
  return state;
}

/**
 * Быстрый ответ для кнопки счётчика: читаем файл С КОНЦА кусками и ищем
 * последнее значимое событие — ответ основной ветки с usage или границу
 * сжатия. Ничего не знает про суммы за чат (`session.*`) — их считает только
 * полный разбор. `found` false = в хвосте значимых строк не нашлось, тогда
 * вызывающий идёт полным разбором.
 */
async function scanClaudeTranscriptTail(filePath: string): Promise<ClaudeScanState | null> {
  const stat = await fsp.stat(filePath);
  const state = newScanState();
  const handle = await fsp.open(filePath, 'r');
  try {
    // Идём от конца кусками. Строка, обрезанная куском у НАЧАЛА, остаётся в
    // `pending` и доклеивается к следующему (более раннему) куску — как в
    // прямом разборе, только в обратную сторону. Байтовая позиция каждой
    // строки нужна лишь для сравнения «что позже»: usage или граница сжатия.
    let end = stat.size;
    let pending = '';
    let scanned = 0;
    let lastUsage: (UsageParts & { model: string | null; bytePos: number }) | null = null;
    let lastBoundary: { postTokens: number; preTokens: number; bytePos: number } | null = null;
    let maxObserved = 0;

    while (end > 0 && scanned < TAIL_SCAN_MAX_BYTES && !(lastUsage && lastBoundary)) {
      const length = Math.min(TAIL_SCAN_CHUNK_BYTES, end);
      const start = end - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead <= 0) break;
      scanned += bytesRead;
      let text = buffer.subarray(0, bytesRead).toString('utf8') + pending;
      if (start > 0) {
        const firstNl = text.indexOf('\n');
        if (firstNl === -1) {
          // Кусок — одна недописанная строка: уходит в pending целиком.
          pending = text;
          end = start;
          continue;
        }
        pending = text.slice(0, firstNl);
        text = text.slice(firstNl + 1);
      } else {
        pending = '';
      }
      end = start;
      const lines = text.split('\n');
      // Приблизительная позиция строки в файле — хватает для сравнения порядка.
      let lineEnd = end;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        lineEnd -= line.length + 1;
        if (!line || (!line.includes('"usage"') && !line.includes('compact_boundary'))) continue;
        let entry: AnyRecord;
        try {
          entry = JSON.parse(line) as AnyRecord;
        } catch {
          continue;
        }
        if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
          if (!lastBoundary) {
            const meta = entry.compactMetadata ?? {};
            lastBoundary = {
              postTokens: Math.max(0, readUsageNumber(meta.postTokens ?? meta.post_tokens)),
              preTokens: Math.max(0, readUsageNumber(meta.preTokens ?? meta.pre_tokens)),
              bytePos: lineEnd,
            };
          }
          continue;
        }
        const usage = entry.type === 'assistant' ? entry.message?.usage : null;
        if (!usage || typeof usage !== 'object') continue;
        const parts = readUsageParts(usage as AnyRecord);
        const isEmpty = parts.input + parts.output + parts.cacheRead + parts.cacheCreation === 0;
        if (isEmpty) continue;
        const model = typeof entry.message?.model === 'string' ? entry.message.model : null;
        const isMainChain = entry.isSidechain !== true && !entry.isApiErrorMessage && model !== '<synthetic>';
        if (!isMainChain || contextOf(parts) <= 0) continue;
        maxObserved = Math.max(maxObserved, contextOf(parts));
        if (!lastUsage) {
          lastUsage = { ...parts, model, bytePos: lineEnd };
        }
      }
      // Уступаем цикл между кусками — как в полном разборе.
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (!lastUsage && !lastBoundary) return null;

    if (lastBoundary && (!lastUsage || lastBoundary.bytePos > lastUsage.bytePos)) {
      state.compactPostTokens = lastBoundary.postTokens > 0 ? lastBoundary.postTokens : null;
      state.maxObservedContext = Math.max(maxObserved, lastBoundary.preTokens);
    } else if (lastUsage) {
      state.lastMain = { ...lastUsage };
      state.maxObservedContext = maxObserved;
    }
    if (lastUsage?.model) state.model = lastUsage.model;
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
    return state;
  } finally {
    await handle.close();
  }
}

/**
 * Полный разбор в единственном экземпляре на файл: параллельные запросы и
 * фоновая добивка делят один проход.
 */
function runScanDeduped(filePath: string): Promise<ClaudeScanState> {
  const running = runningFullScans.get(filePath);
  if (running) return running;
  const task = scanClaudeTranscript(filePath)
    .finally(() => {
      runningFullScans.delete(filePath);
    });
  runningFullScans.set(filePath, task);
  return task;
}

/**
 * Полный разбор в фоне: следующий запрос получит `session.*` итоги из кэша.
 * Ошибки гасим — фон не должен ронять процесс; следующий запрос попробует снова.
 */
function scheduleFullScan(filePath: string): void {
  void runScanDeduped(filePath).catch(() => undefined);
}

function buildClaudeTokenUsage(
  state: ClaudeScanState,
  contextWindow: number,
): TokenUsageResult {
  const last = state.lastMain;
  const contextTokens = state.compactPostTokens ?? (last ? contextOf(last) : 0);
  const lastInput = last ? contextOf(last) : 0;
  const lastOutput = last ? last.output : 0;
  const totals = state.totals;
  const sessionInput = totals.input + totals.cacheRead + totals.cacheCreation;

  return {
    // `used` — заполненность контекста, как и раньше (кнопка у поля ввода).
    used: contextTokens,
    total: contextWindow,
    inputTokens: lastInput,
    outputTokens: lastOutput,
    cacheReadTokens: last ? last.cacheRead : 0,
    cacheCreationTokens: last ? last.cacheCreation : 0,
    cacheTokens: last ? last.cacheRead + last.cacheCreation : 0,
    breakdown: { input: lastInput, output: lastOutput },
    contextTokens,
    contextWindow,
    contextPercent: contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 1000) / 10 : 0,
    model: state.model,
    // Суммы за весь чат — только когда разбор дошёл до конца файла. У быстрого
    // ответа с хвоста их нет: непроверенные «итоги» хуже, чем их отсутствие —
    // потребитель увидит `session === undefined` и поймёт, что данных пока нет.
    ...(state.complete
      ? {
        session: {
          inputTokens: sessionInput,
          outputTokens: totals.output,
          freshInputTokens: totals.input,
          cacheReadTokens: totals.cacheRead,
          cacheCreationTokens: totals.cacheCreation,
          totalTokens: sessionInput + totals.output,
          requests: state.requests.size,
        },
      }
      : {}),
  };
}

function readOpenCodeTokenUsage(databasePath: string, providerSessionId: string): TokenUsageResult {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = [
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
    ];

    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return {
        used: 0,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
        unsupported: true,
        message: 'Token usage tracking is not available in this OpenCode database schema',
      };
    }

    const row = database.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(providerSessionId) as OpenCodeTokenRow | undefined;

    if (!row) {
      throw new AppError('OpenCode session was not found.', {
        code: 'OPENCODE_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const inputTokens = readUsageNumber(row.inputTokens) + readUsageNumber(row.cacheReadTokens);
    const outputTokens = readUsageNumber(row.outputTokens);
    const used = readUsageNumber(row.inputTokens)
      + outputTokens
      + readUsageNumber(row.reasoningTokens)
      + readUsageNumber(row.cacheReadTokens)
      + readUsageNumber(row.cacheWriteTokens);

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  } finally {
    database.close();
  }
}

/**
 * Creates the provider token-usage service used by the provider routes. The
 * provider test suite supplies isolated filesystem and session dependencies so
 * every calculator can be exercised without touching a developer's real data.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    /**
     * Resolves all provider-specific storage details from one app-facing
     * session id, then returns the latest usage snapshot for that provider.
     */
    async getSessionTokenUsage(sessionId: string): Promise<TokenUsageResult> {
      // Страница знает чат то по номеру сайта, то (новый чат, первые секунды) по номеру у Claude.
      const session = dependencies.getSessionById(sessionId)
        ?? dependencies.getSessionByProviderSessionId?.(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const providerSessionId = session.provider_session_id || session.session_id || sessionId;

      if (session.provider === 'devin') {
        // Devin пишет расход каждого ответа в sessions.db своего канала —
        // читаем его, как читаем стенограмму Claude. Беседы у Devin нет (чат
        // без ходов) — нули, но окно уже настоящее, а не «недоступно».
        const connXdg = session.devin_connection_id != null
          ? devinConnectionsDb.getById(session.devin_connection_id)?.xdg_data_home
          : null;
        const usage = dependencies.readDevinTokenUsage(providerSessionId, {
          modelHint: session.model,
          xdgDataHome: connXdg ?? null,
        });
        if (usage) {
          return usage;
        }
        return {
          used: 0,
          total: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Devin session was not found in the Devin database',
        };
      }

      if (session.provider === 'cursor') {
        return {
          used: 0,
          total: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking not available for Cursor sessions',
        };
      }

      if (session.provider === 'opencode') {
        const databasePath = dependencies.getOpenCodeDatabasePath();
        if (!dependencies.fileExists(databasePath)) {
          throw new AppError('OpenCode database was not found.', {
            code: 'OPENCODE_DATABASE_NOT_FOUND',
            statusCode: 404,
          });
        }

        return readOpenCodeTokenUsage(databasePath, providerSessionId);
      }

      if (session.provider === 'codex') {
        const indexedFilePath = session.jsonl_path && dependencies.fileExists(session.jsonl_path)
          ? session.jsonl_path
          : null;
        const sessionFilePath = indexedFilePath ?? await findCodexSessionFile(
          path.join(dependencies.getHomeDirectory(), '.codex', 'sessions'),
          providerSessionId,
          dependencies,
        );

        if (!sessionFilePath) {
          throw new AppError(`Codex session file for "${sessionId}" was not found.`, {
            code: 'CODEX_SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const fileContent = await dependencies.readTextFile(sessionFilePath);
        return readCodexTokenUsage(fileContent);
      }

      let sessionFilePath = session.jsonl_path;
      if (!sessionFilePath) {
        if (!session.project_path) {
          throw new AppError(`Session file for "${sessionId}" was not found.`, {
            code: 'SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const encodedProjectPath = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDirectory = path.join(
          dependencies.getHomeDirectory(),
          '.claude',
          'projects',
          encodedProjectPath,
        );
        sessionFilePath = path.join(projectDirectory, `${providerSessionId}.jsonl`);

        const relativePath = path.relative(path.resolve(projectDirectory), path.resolve(sessionFilePath));
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          throw new AppError('Resolved session path is invalid.', {
            code: 'INVALID_SESSION_PATH',
            statusCode: 400,
          });
        }
      }

      if (!dependencies.fileExists(sessionFilePath)) {
        throw new AppError(`Session file for "${sessionId}" was not found.`, {
          code: 'SESSION_FILE_NOT_FOUND',
          statusCode: 404,
        });
      }

      const statNow = await fsp.stat(sessionFilePath);
      let state = scanStates.get(sessionFilePath);
      const cacheCurrent = Boolean(
        state?.complete && state.size === statNow.size && state.mtimeMs === statNow.mtimeMs,
      );
      if (!cacheCurrent) {
        // Инкрементальная добивка дописанного хвоста дёшево — делаем её сразу.
        // Полный разбор большого файла в ответе не ждём: кнопке хватает хвоста.
        const incrementalIsCheap = Boolean(state?.complete) && statNow.size >= (state?.size ?? 0);
        if (statNow.size >= TAIL_ANSWER_MIN_FILE_BYTES && !incrementalIsCheap) {
          const tailState = await scanClaudeTranscriptTail(sessionFilePath);
          if (tailState) {
            scheduleFullScan(sessionFilePath);
            state = tailState;
          } else {
            state = await runScanDeduped(sessionFilePath);
          }
        } else {
          state = await runScanDeduped(sessionFilePath);
        }
      }
      if (!state) {
        throw new AppError(`Session file for "${sessionId}" could not be scanned.`, {
          code: 'SESSION_SCAN_FAILED',
          statusCode: 500,
        });
      }
      const configuredWindow = Number.parseInt(dependencies.getClaudeContextWindow() ?? '', 10);
      const contextWindow = Number.isFinite(configuredWindow) && configuredWindow > 0
        ? configuredWindow
        : dependencies.resolveClaudeContextWindow({
          sessionIds: [session.session_id, providerSessionId, sessionId],
          sessionModel: session.model,
          maxObservedContext: state.maxObservedContext,
        });
      return buildClaudeTokenUsage(state, contextWindow);
    },
  };
}

/**
 * Used by the provider routes to serve token usage from only an app session id.
 */
export const providerTokenUsageService = createProviderTokenUsageService();
