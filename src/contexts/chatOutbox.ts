/**
 * Очередь отправки сообщений чата: сообщение не теряется, пока сервер не
 * расписался в получении.
 *
 * Как было. `sendMessage` отдавал сообщение в сокет, если тот «открыт», а
 * иначе молча выбрасывал. Сообщение при этом уже стояло в ленте, поле ввода
 * очищалось — человек видел отправленное сообщение, которого сервер не
 * получал. На iPhone после возврата приложения из фона сокет часто
 * «полумёртвый»: считается открытым, а данные уходят в никуда. 13–15.09.26
 * так пропали первые сообщения трёх новых чатов: чат на сервере создан
 * (отдельный HTTP-запрос), а `chat.send` в журнале сервера нет вовсе.
 *
 * Как стало. Каждое `chat.send` получает постоянный номер
 * (`clientMessageId`) и лежит здесь (и в localStorage — переживает
 * перезагрузку и выгрузку приложения из памяти), пока не придёт расписка
 * `chat_send_ack` с этим номером или отказ сервера (`protocol_error` с
 * номером). Повторы безопасны: сервер по номеру узнаёт уже принятое и второй
 * запуск не заводит (server/.../chat-send-ledger.service.ts).
 *
 * Модуль без React и без сокета — только учёт; когда слать и когда рвать
 * связь, решает WebSocketContext.
 */

export type OutboxEntry = {
  id: string;
  message: Record<string, unknown>;
  queuedAt: number;
  /** Сколько раз сообщение действительно ушло в сокет. */
  attempts: number;
  lastSentAt: number | null;
};

type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const OUTBOX_STORAGE_KEY = 'chat_send_outbox_v1';
/** Дольше этого сообщение не досылается само: через часы оно может быть уже неуместно. */
export const OUTBOX_ENTRY_TTL_MS = 2 * 60 * 60 * 1000;
/** После стольких отправок без расписки человеку честно говорится, что сообщение не дошло. */
export const OUTBOX_MAX_ATTEMPTS = 6;

export function isChatSend(message: unknown): message is Record<string, unknown> {
  return Boolean(message)
    && typeof message === 'object'
    && (message as Record<string, unknown>).type === 'chat.send';
}

export function newClientMessageId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export class ChatOutbox {
  private readonly entries = new Map<string, OutboxEntry>();

  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.load();
  }

  /** Ставит сообщение в очередь; номер сохраняется, если он уже был. */
  add(message: Record<string, unknown>): OutboxEntry {
    const existingId = typeof message.clientMessageId === 'string' ? message.clientMessageId : '';
    const id = existingId || newClientMessageId();
    const known = this.entries.get(id);
    if (known) {
      return known;
    }
    const entry: OutboxEntry = {
      id,
      message: { ...message, clientMessageId: id },
      queuedAt: this.now(),
      attempts: 0,
      lastSentAt: null,
    };
    this.entries.set(id, entry);
    this.save();
    return entry;
  }

  /** Расписка или окончательный отказ сервера: сообщение больше не досылается. */
  settle(id: unknown): boolean {
    if (typeof id !== 'string' || !this.entries.delete(id)) {
      return false;
    }
    this.save();
    return true;
  }

  /** Снять все сообщения чата: сервер сказал, что чат занят, — повтор не поможет. Возвращает снятые. */
  settleSession(sessionId: string): OutboxEntry[] {
    const removed = this.pending().filter((entry) => entry.message.sessionId === sessionId);
    for (const entry of removed) {
      this.entries.delete(entry.id);
    }
    if (removed.length > 0) this.save();
    return removed;
  }

  markSent(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    entry.attempts += 1;
    entry.lastSentAt = this.now();
    this.save();
  }

  pending(): OutboxEntry[] {
    return [...this.entries.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Отправлены, но расписки нет дольше `ackTimeoutMs`. */
  overdue(ackTimeoutMs: number): OutboxEntry[] {
    const now = this.now();
    return this.pending().filter((entry) => entry.lastSentAt !== null && now - entry.lastSentAt >= ackTimeoutMs);
  }

  /**
   * Забирает из очереди сообщения, которые больше не досылаются: слишком
   * старые или исчерпавшие попытки без расписки.
   */
  takeGivenUp(ackTimeoutMs: number): OutboxEntry[] {
    const now = this.now();
    const givenUp = this.pending().filter((entry) => (
      now - entry.queuedAt >= OUTBOX_ENTRY_TTL_MS
      || (entry.attempts >= OUTBOX_MAX_ATTEMPTS && entry.lastSentAt !== null && now - entry.lastSentAt >= ackTimeoutMs)
    ));
    if (givenUp.length > 0) {
      for (const entry of givenUp) {
        this.entries.delete(entry.id);
      }
      this.save();
    }
    return givenUp;
  }

  private load(): void {
    if (!this.storage) {
      return;
    }
    try {
      const raw = this.storage.getItem(OUTBOX_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as OutboxEntry[];
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        if (entry && typeof entry.id === 'string' && isChatSend(entry.message)) {
          this.entries.set(entry.id, {
            id: entry.id,
            message: entry.message,
            queuedAt: Number(entry.queuedAt) || this.now(),
            attempts: Number(entry.attempts) || 0,
            lastSentAt: typeof entry.lastSentAt === 'number' ? entry.lastSentAt : null,
          });
        }
      }
    } catch {
      // Битая запись — начинаем с пустой очереди.
    }
  }

  private save(): void {
    if (!this.storage) {
      return;
    }
    try {
      if (this.entries.size === 0) {
        this.storage.removeItem(OUTBOX_STORAGE_KEY);
      } else {
        this.storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(this.pending()));
      }
    } catch {
      // Хранилище недоступно (приватный режим, переполнено) — очередь живёт в памяти.
    }
  }
}
