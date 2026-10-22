import fsSync from 'node:fs';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { fullDevinConversation } from '@/modules/providers/list/devin/devin-chain.js';
import { isDevinAutoContinueText, readJsonRecord, readOptionalString } from '@/shared/utils.js';

/**
 * Текст переписки Devin для поискового индекса.
 *
 * Разбор цепочки сообщений из sessions.db Devin (4+ ГБ, JSON с выводами
 * инструментов) стоит до нескольких секунд на чат и целиком синхронный.
 * В основном потоке сервера он замораживал WebSocket и запросы всех людей
 * (замер 22.10.26: до 9 с подряд), поэтому индекс зовёт его в отдельном
 * потоке. Нет файла потока (tsx-тесты, dev) или поток умер — тот же разбор
 * прямо здесь: поиск работает, просто без разгрузки.
 */

type AnyRecord = Record<string, any>;
type DevinDb = InstanceType<typeof Database>;

export function extractDevinTexts(db: DevinDb, providerSessionId: string): string[] {
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

/** Открытые только на чтение базы Devin — по пути, на время жизни процесса/потока. */
export function createDevinDbCache(): (dbPath: string) => DevinDb | null {
  const cache = new Map<string, DevinDb | null>();
  return (dbPath) => {
    if (!cache.has(dbPath)) {
      let opened: DevinDb | null = null;
      try {
        opened = new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch {
        opened = null;
      }
      cache.set(dbPath, opened);
    }
    return cache.get(dbPath) ?? null;
  };
}

export function extractDevinBody(openDb: (dbPath: string) => DevinDb | null, dbPath: string, providerSessionId: string): string {
  const db = openDb(dbPath);
  if (!db) return '';
  try {
    return extractDevinTexts(db, providerSessionId).join('\n');
  } catch {
    return '';
  }
}

// Один разбор не дольше минуты; больше — поток перезапускается, а чат
// остаётся «грязным» (null → без записи в индекс) и пробуется следующей сверкой.
const WORKER_TIMEOUT_MS = 60_000;
// Куча потока отдельно от сервера: гигантская переписка роняет поток, не сайт.
const WORKER_HEAP_MB = 384;
const WORKER_URL = new URL('./chat-search-devin.worker.js', import.meta.url);

type Pending = { resolve: (text: string | null) => void; timer: NodeJS.Timeout };

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, Pending>();
// Поток разбирает по одному, поэтому и запросы отдаём по одному: таймаут
// тогда меряет разбор именно этого чата, а не ожидание в очереди.
let queue: Promise<unknown> = Promise.resolve();
let inlineOpenDb: ((dbPath: string) => DevinDb | null) | null = null;

function settleAll(text: string | null): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve(text);
    pending.delete(id);
  }
}

function dropWorker(): void {
  const current = worker;
  worker = null;
  settleAll(null);
  void current?.terminate().catch(() => undefined);
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (!fsSync.existsSync(WORKER_URL)) return null;
  try {
    const created = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    created.unref();
    created.on('message', (message: { id: number; text: string }) => {
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      entry.resolve(message.text);
    });
    created.on('error', (error) => {
      console.warn('[chat-search] поток разбора Devin упал:', error instanceof Error ? error.message : error);
      if (worker === created) dropWorker();
    });
    created.on('exit', () => {
      if (worker === created) dropWorker();
    });
    worker = created;
    return created;
  } catch (error) {
    console.warn('[chat-search] поток разбора Devin не создан:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Текст чата Devin, не блокируя основной поток сервера (если поток доступен).
 * null — разбор не удался (таймаут, падение потока): чат в индекс не пишется.
 */
export function extractDevinBodyOffThread(dbPath: string, providerSessionId: string): Promise<string | null> {
  const run = queue.then(() => runInWorker(dbPath, providerSessionId));
  queue = run.catch(() => undefined);
  return run;
}

function runInWorker(dbPath: string, providerSessionId: string): Promise<string | null> {
  const target = getWorker();
  if (!target) {
    inlineOpenDb ??= createDevinDbCache();
    return Promise.resolve(extractDevinBody(inlineOpenDb, dbPath, providerSessionId));
  }
  const id = ++nextRequestId;
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[chat-search] разбор Devin ${providerSessionId} дольше ${WORKER_TIMEOUT_MS / 1000} с — перезапуск потока`);
      if (worker === target) dropWorker();
    }, WORKER_TIMEOUT_MS);
    timer.unref();
    pending.set(id, { resolve, timer });
    target.postMessage({ id, dbPath, providerSessionId });
  });
}
