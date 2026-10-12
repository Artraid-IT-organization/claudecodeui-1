import { readDraftInput, writeDraftInput } from '../components/chat/utils/chatStorage';
import { authenticatedFetch } from '../utils/api';

/**
 * Куда должна попасть расшифровка: чат, в котором надиктовали.
 *
 * Звук уже не теряется (куски на диске телефона → очередь до ответа сервера →
 * архив и Telegram на самом сервере), а вот текст до 12.10.26 терялся в трёх
 * местах: страница закрылась или человек ушёл в другой чат, пока шла
 * расшифровка; очередь дошлёвывала запись, но ответ просто выбрасывался;
 * повторная загрузка плодила дубли в архиве.
 *
 * Теперь у записи есть адресат: чат (`sessionId`) или черновик области
 * (`scope` — то же, что у `draft_input_*`). Пришедший текст кладётся в
 * устойчивое место ДО того, как его увидит экран: в черновик чата, в очередь
 * отправки (send) или в живое поле ввода, если нужный чат открыт прямо сейчас.
 * Сервер держит свою копию (таблица `voice_transcripts`) и отдаёт недошедшее
 * при входе — прочищенное хранилище телефона уже не приговор.
 */

export type VoiceTarget = {
  /** Чат-получатель; у нового чата без id его нет — тогда цель только scope. */
  sessionId?: string | null;
  /** Область черновика (`draftScopeFor`): sessionId либо `project:<id>`. */
  scope?: string | null;
};

type LiveInsert = (text: string, send: boolean) => void;
type Dispatcher = (sessionId: string, text: string) => void;

type QueuedVoiceSend = {
  id: string;
  sessionId: string;
  text: string;
  at: number;
};

const SEND_QUEUE_KEY = 'voice_send_queue_v1';
const DELIVERED_KEY = 'voice_delivered_v1';
const DELIVERED_CAP = 300;
const INBOX_SYNC_MS = 60_000;
/** Скопы без адресата регистрируются сюда (терминал и т.п.): совпадение = «тот же обработчик, что диктовал». */
const DIRECT_SCOPE = '__direct__';

const liveInserts = new Map<string, LiveInsert>();
let dispatcher: Dispatcher | null = null;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readSendQueue(): QueuedVoiceSend[] {
  const items = readJson<QueuedVoiceSend[]>(SEND_QUEUE_KEY, []);
  return Array.isArray(items) ? items.filter((i) => i && typeof i.text === 'string' && typeof i.sessionId === 'string') : [];
}

function writeSendQueue(items: QueuedVoiceSend[]): void {
  try {
    localStorage.setItem(SEND_QUEUE_KEY, JSON.stringify(items.slice(-50)));
  } catch {
    /* место кончилось — запись и так в архиве сервера */
  }
}

const deliveredIds = new Set<string>(readJson<string[]>(DELIVERED_KEY, []));

function persistDelivered(): void {
  try {
    localStorage.setItem(DELIVERED_KEY, JSON.stringify([...deliveredIds].slice(-DELIVERED_CAP)));
  } catch {
    /* не критично: повторная доставка безопасна за счёт того же набора в памяти */
  }
}

function scopeKey(scope: string | null | undefined): string {
  return scope || DIRECT_SCOPE;
}

/**
 * Живое поле ввода регистрирует себя под своим scope: расшифровка для
 * открытого чата попадает прямо в поле (и сама сохраняется черновиком),
 * для остальных — в их черновики/очередь. Возвращает снятие регистрации.
 */
export function registerVoiceInsert(scope: string | null | undefined, insert: LiveInsert): () => void {
  const key = scopeKey(scope);
  liveInserts.set(key, insert);
  return () => {
    if (liveInserts.get(key) === insert) liveInserts.delete(key);
  };
}

/**
 * Отправщик `chat.send` из живого приложения: нужен для диктовок «с отсылкой»,
 * чей чат сейчас не открыт. При регистрации досылает всё, что легло в очередь,
 * пока отправителя не было (запись улетела с закрытой вкладкой чата).
 */
export function registerVoiceDispatcher(fn: Dispatcher): () => void {
  dispatcher = fn;
  drainSendQueue();
  return () => {
    if (dispatcher === fn) dispatcher = null;
  };
}

/**
 * «Отправить в чат» без открытого чата: текст ждёт в localStorage, пока
 * приложение не сможет передать его в `chat.send` — а тот сам лежит в очереди
 * до расписки сервера (chatOutbox). Без диспетчера запись просто лежит.
 */
function drainSendQueue(): void {
  if (!dispatcher) return;
  const rest: QueuedVoiceSend[] = [];
  for (const item of readSendQueue()) {
    try {
      dispatcher(item.sessionId, item.text);
    } catch {
      rest.push(item); // отправщик занят — запись остаётся и уйдёт со следующим диспетчером
    }
  }
  writeSendQueue(rest);
}

export type DeliveryResult = 'live' | 'queued' | 'draft' | 'dropped';

/**
 * Положить расшифровку в прочное место её чата. Идемпотентно по recId:
 * один и тот же текст может прийти и из живого ответа, и из серверного
 * инбокса — второй раз он не вставится.
 */
export function deliverTranscript(args: VoiceTarget & { recId?: string | null; text: string; send?: boolean }): DeliveryResult {
  const text = args.text.trim();
  if (!text) return 'dropped';
  if (args.recId) {
    if (deliveredIds.has(args.recId)) return 'dropped';
    deliveredIds.add(args.recId);
    persistDelivered();
  }

  const insert = liveInserts.get(scopeKey(args.scope));
  if (insert) {
    insert(text, Boolean(args.send));
    return 'live';
  }
  if (args.send && args.sessionId) {
    const queue = readSendQueue();
    queue.push({ id: args.recId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, sessionId: args.sessionId, text, at: Date.now() });
    writeSendQueue(queue);
    drainSendQueue();
    return 'queued';
  }
  if (args.scope) {
    const base = readDraftInput(args.scope).trim();
    writeDraftInput(args.scope, base ? `${base} ${text}` : text);
    return 'draft';
  }
  return 'dropped';
}

/** Подтверждение серверу: текст лёг куда надо, копию из инбокса можно закрывать. */
function acknowledge(recId: string): void {
  void authenticatedFetch('/api/voice/transcripts/delivered', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recId }),
  }).catch(() => undefined); // не вышло — дошлём при следующей синхронизации
}

/** Живой ответ довёл текст сам — закрываем его строку в серверном инбоксе, не дожидаясь тика синхронизации. */
export function acknowledgeTranscript(recId: string | null | undefined): void {
  if (recId) acknowledge(recId);
}

type InboxItem = { recId?: string; sessionId?: string | null; scope?: string | null; send?: boolean; text?: string };

let syncing = false;

/** Забрать с сервера расшифровки, которые ответ до экрана не донёс. */
export async function syncServerInbox(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const res = await authenticatedFetch('/api/voice/transcripts/pending');
    if (!res.ok) return;
    const data = (await res.json()) as { items?: InboxItem[] };
    for (const item of data.items ?? []) {
      if (!item.recId || !item.text) continue;
      const how = deliverTranscript({
        recId: item.recId,
        sessionId: item.sessionId,
        scope: item.scope,
        text: item.text,
        send: item.send,
      });
      // «Доставлено» — в любом виде, включая «девать некуда»: без адресата
      // запись всё равно никогда никуда не попадёт, а крутить её в инбоксе
      // вечно бессмысленно (звук и так в архиве сервера).
      if (how !== 'dropped' || deliveredIds.has(item.recId)) acknowledge(item.recId);
    }
  } catch {
    /* сети нет — следующий тик */
  } finally {
    syncing = false;
  }
}

let inboxStarted = false;

/** Синхронизация серверного инбокса: при старте, при сети/возврате и раз в минуту. */
export function startServerInboxSync(): void {
  if (inboxStarted || typeof window === 'undefined') return;
  inboxStarted = true;
  const kick = () => void syncServerInbox();
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  setInterval(kick, INBOX_SYNC_MS);
  kick();
}
