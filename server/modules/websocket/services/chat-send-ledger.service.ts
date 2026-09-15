/**
 * Журнал принятых сообщений: по нему повторная отправка того же сообщения
 * не заводит второй запуск.
 *
 * Зачем. Телефон теперь держит сообщение в очереди, пока сервер не
 * распишется в получении (`chat_send_ack`), и отправляет его заново после
 * переподключения. Расписка может потеряться вместе со связью — тогда до
 * сервера дойдёт копия уже принятого сообщения. Номер сообщения
 * (`clientMessageId`) придумывает телефон один раз и не меняет при повторах;
 * сервер помнит принятые номера и на копию отвечает распиской, не запуская
 * агента второй раз.
 *
 * Журнал лежит на диске, а не только в памяти: сообщение могло быть принято
 * прошлым сервером прямо перед перезапуском сайта, а агент — продолжать
 * работу (см. survivor-runs.js). Файл рядом с базой своего экземпляра, чтобы
 * два экземпляра сайта не переписывали один файл.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Сколько помнить принятое сообщение. Повтор позже этого срока — уже новое сообщение. */
const LEDGER_TTL_MS = 6 * 60 * 60 * 1000;

let entries: Map<string, number> | null = null;

function ledgerPath(): string {
  if (process.env.CLOUDCLI_SEND_LEDGER_PATH) {
    return process.env.CLOUDCLI_SEND_LEDGER_PATH;
  }
  const dbPath = process.env.DATABASE_PATH;
  const dir = dbPath ? path.dirname(dbPath) : path.join(os.homedir(), '.cloudcli');
  return path.join(dir, 'chat-send-ledger.json');
}

function keyOf(sessionId: string, clientMessageId: string): string {
  return `${sessionId}:${clientMessageId}`;
}

function load(): Map<string, number> {
  if (entries) {
    return entries;
  }
  entries = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')) as Record<string, unknown>;
    const now = Date.now();
    for (const [key, acceptedAt] of Object.entries(raw)) {
      if (typeof acceptedAt === 'number' && now - acceptedAt < LEDGER_TTL_MS) {
        entries.set(key, acceptedAt);
      }
    }
  } catch {
    // Файла ещё нет или он битый — начинаем с пустого журнала.
  }
  return entries;
}

function persist(map: Map<string, number>): void {
  const now = Date.now();
  for (const [key, acceptedAt] of map) {
    if (now - acceptedAt >= LEDGER_TTL_MS) {
      map.delete(key);
    }
  }
  const file = ledgerPath();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
    fs.renameSync(tmp, file);
  } catch (error) {
    // Не записали — в памяти номер остаётся, защита работает до перезапуска.
    console.error('[chat-send-ledger] журнал принятых сообщений не сохранился:', error instanceof Error ? error.message : error);
  }
}

/** Номер сообщения от телефона; всё непохожее на номер отбрасывается. */
export function readClientMessageId(data: Record<string, unknown>): string | null {
  const value = data.clientMessageId;
  if (typeof value !== 'string') {
    return null;
  }
  return /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : null;
}

export function hasAcceptedSend(sessionId: string, clientMessageId: string): boolean {
  return load().has(keyOf(sessionId, clientMessageId));
}

export function rememberAcceptedSend(sessionId: string, clientMessageId: string): void {
  const map = load();
  map.set(keyOf(sessionId, clientMessageId), Date.now());
  persist(map);
}

/** Для тестов: забыть загруженное, чтобы следующий вызов перечитал файл. */
export function resetSendLedgerForTests(): void {
  entries = null;
}
