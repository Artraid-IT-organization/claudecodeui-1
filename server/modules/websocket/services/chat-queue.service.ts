/**
 * Очередь сообщений чата: хранение, показ всем устройствам и отправка по
 * концу хода — силами сервера.
 *
 * Егор 20.09.26: «если я запустил размышление и отправил следующее сообщение,
 * оно выложилось только тогда, когда я вошёл в сайт. Оно должно запускаться
 * сразу после того, как закончится настоящее размышление, и остальная очередь
 * тоже — она никак не зависит от моего присутствия».
 *
 * Раньше очередь жила в localStorage вкладки и отправлялась страницей: пока
 * сайт закрыт, отправлять некому. Теперь:
 * - строки лежат в базе (`chat_message_queue`) и переживают перезапуск сайта;
 * - страница только показывает очередь и правит её — источником правды она не
 *   является, поэтому телефон и компьютер видят одно и то же;
 * - по концу каждого хода сервер сам снимает первую строку и заводит запуск,
 *   даже если ни одной вкладки не открыто.
 *
 * Отправитель живёт в chat-websocket.service (там разбор настроек, вложений и
 * доступа к провайдеру); сюда он подставляется через `setQueuedChatMessageRunner`,
 * иначе два модуля ссылались бы друг на друга по кругу.
 */
import { chatMessageQueueDb, sessionsDb, type StoredQueuedChatMessage } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { broadcastRealtimeEvent } from '@/modules/websocket/services/websocket-state.service.js';
import { normalizeAttachmentDescriptors } from '@/shared/image-attachments.js';

/**
 * Что о строке очереди знает страница: текст, вложения и номер. Настройки
 * запуска (модель, права) наружу не отдаём — показывать их негде, а размер
 * рассылки они увеличивают. `error` — у строки в состоянии `failed`: сервер
 * сдался после всех попыток, причина показывается человеку под текстом.
 */
export type QueuedChatMessageView = {
  id: string;
  content: string;
  attachments: unknown[];
  createdAt: string;
  error?: string;
};

/**
 * Заводит запуск по захваченной строке очереди. Возвращает `false`, если
 * запуск завести не удалось (чат уже работает, исчерпан предел одновременных
 * чатов, вход закрыт на перезапуск) — тогда захват просто снимается и строка
 * ждёт следующего обхода. `true` — запуск завёлся и САМ доводит строку до
 * конца: `markDelivered` на якоре, возврат захвата со счётчиком при падении,
 * `markFailed` после всех попыток.
 */
export type QueuedChatMessageRunner = (message: StoredQueuedChatMessage) => Promise<boolean>;

let runQueuedMessage: QueuedChatMessageRunner | null = null;
/**
 * Обход очередей идёт по одному: несколько ходов могут закончиться разом.
 *
 * Признак — именно флаг, а не «промис обхода»: пустой обход заканчивается
 * раньше, чем промис успевает записаться в переменную, и та навсегда
 * оставалась занятой — очередь после этого не трогалась вовсе (поймано живым
 * прогоном 20.09.26).
 */
let sweeping = false;
let sweepRequested = false;

/** Вызывается при поднятии websocket-модуля: подставляет настоящего отправителя. */
export function setQueuedChatMessageRunner(runner: QueuedChatMessageRunner): void {
  runQueuedMessage = runner;
}

function toView(message: StoredQueuedChatMessage): QueuedChatMessageView {
  const options = message.options ?? {};
  const attachments = [
    ...normalizeAttachmentDescriptors(options.attachments),
    ...normalizeAttachmentDescriptors(options.images),
    ...normalizeAttachmentDescriptors(options.files),
  ];
  const unique = attachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );
  return {
    id: message.id,
    content: message.content,
    attachments: unique,
    createdAt: message.createdAt,
    ...(message.state === 'failed' && message.lastError ? { error: message.lastError } : {}),
  };
}

/**
 * Очередь чата в том виде, в каком её показывает страница. Захваченные строки
 * скрываем: они уже «в пути» к агенту (раньше их и вовсе не было в таблице —
 * снимались на запуск), вернутся видимыми сами, если ход до агента не доедет.
 * Отказавшие (`failed`) видны всегда — это не «в пути», а честная ошибка.
 */
export function listChatQueue(sessionId: string): QueuedChatMessageView[] {
  return chatMessageQueueDb.list(sessionId)
    .filter((message) => !message.claimedAt || message.state === 'failed')
    .map(toView);
}

/**
 * Рассылает очередь ВСЕМ подключённым устройствам, а не только тому, кто её
 * изменил: очередь общая, и на телефоне она должна меняться одновременно с
 * компьютером.
 */
export function broadcastChatQueue(sessionId: string): void {
  const payload = JSON.stringify({
    kind: 'chat_queue',
    sessionId,
    queue: listChatQueue(sessionId),
    timestamp: new Date().toISOString(),
  });
  broadcastRealtimeEvent(payload, sessionsDb.getSessionById(sessionId)?.provider);
}

/** Ставит сообщение в конец очереди и рассылает новый вид очереди. */
export function queueChatMessage(message: Omit<StoredQueuedChatMessage, 'createdAt' | 'claimedAt' | 'state' | 'lastError'>): QueuedChatMessageView[] {
  chatMessageQueueDb.append(message);
  const queue = listChatQueue(message.sessionId);
  broadcastChatQueue(message.sessionId);
  return queue;
}

/**
 * Верх попыток одной строки: сторож обходит очереди раз в минуту, столько
 * неудач доставки ≈ полчаса реальных попыток. Дальше — честный `failed`
 * вместо бесконечного молчаливого перезапуска.
 */
const MAX_DELIVERY_ATTEMPTS = 30;

/**
 * Пауза между возвратом недошедшего сообщения и следующей попыткой — равна
 * периоду сторожа (минута). Без неё конец упавшего хода сам тут же дёргал бы
 * обход, и попытки сгорали бы подряд, не дожидаясь временной причины — замок
 * выжившего агента живёт порядка минуты.
 */
const REDELIVERY_BACKOFF_MS = 60_000;

/**
 * Заведомо недоставимо: чат удалён, провайдер выключен, нет доступа — повтор
 * не поможет. Строка остаётся в базе помеченной `failed` и видна человеку в
 * доке с причиной — решение за ним (исправить, удалить, нажать «Сейчас»).
 * Потребитель: chat-websocket.service — ветки отказа запуска.
 */
export function failQueuedMessageNow(
  message: Pick<StoredQueuedChatMessage, 'id' | 'sessionId' | 'userId' | 'content' | 'options' | 'createdAt'>,
  reason: string,
): void {
  if (!chatMessageQueueDb.has(message.id)) {
    // Строки нет (write-ahead не записался) — сначала возвращаем её, иначе
    // «ошибка» была бы невидима, а сообщение всё равно потеряно.
    chatMessageQueueDb.insertFront(message);
  }
  chatMessageQueueDb.markFailed(message.id, reason);
  broadcastChatQueue(message.sessionId);
}

/**
 * Ход до агента не довёз захваченную строку (упал до передачи prompt):
 * возвращаем её со счётчиком попыток в `options.__redispatch` — обход
 * отправит снова. После потолка попыток помечаем `failed` с причиной —
 * сообщение не исчезает, а показывает честную ошибку (потеря 14.10.26).
 * Потребитель: chat-websocket.service — finally хода до якоря.
 */
export function returnClaimedToQueue(
  message: Pick<StoredQueuedChatMessage, 'id' | 'sessionId' | 'userId' | 'content' | 'options' | 'createdAt'>,
  reason: string,
): 'requeued' | 'failed' {
  const attempts = Number((message.options as Record<string, unknown> | undefined)?.__redispatch ?? 0) + 1;
  if (attempts < MAX_DELIVERY_ATTEMPTS) {
    const notBefore = Date.now() + REDELIVERY_BACKOFF_MS;
    if (chatMessageQueueDb.has(message.id)) {
      chatMessageQueueDb.releaseClaim(message.id, { bumpAttempts: true, notBefore });
    } else {
      chatMessageQueueDb.insertFront({
        ...message,
        options: { ...(message.options ?? {}), __redispatch: attempts, __notBefore: notBefore },
      });
    }
    broadcastChatQueue(message.sessionId);
    return 'requeued';
  }
  failQueuedMessageNow(message, `не дошло до агента за ${MAX_DELIVERY_ATTEMPTS} попыток: ${reason}`);
  return 'failed';
}

export function removeChatQueueItem(sessionId: string, id: string): void {
  chatMessageQueueDb.remove(sessionId, id);
  broadcastChatQueue(sessionId);
}

export function clearChatQueue(sessionId: string): void {
  chatMessageQueueDb.clear(sessionId);
  broadcastChatQueue(sessionId);
}

export function reorderChatQueue(sessionId: string, orderedIds: string[]): void {
  chatMessageQueueDb.reorder(sessionId, orderedIds);
  broadcastChatQueue(sessionId);
}

async function dispatchSession(sessionId: string): Promise<void> {
  const runner = runQueuedMessage;
  if (!runner) {
    return;
  }
  // Пока чат занят — ничего не снимаем. `isProcessing` учитывает и агентов,
  // переживших перезапуск сайта: их ход ещё идёт, хотя запуска в памяти нет.
  if (chatRunRegistry.isProcessing(sessionId)) {
    return;
  }

  // Смотрим первую строку ДО захвата: вернувшееся из хода недошедшее
  // сообщение несёт паузу `__notBefore`, и повторять её раньше отметки нельзя —
  // иначе конец упавшего хода мгновенно дёргает обход, и попытки сгорают
  // подряд, не дожидаясь временной причины (замок выжившего ~минуту).
  const candidate = chatMessageQueueDb.peekFirst(sessionId);
  if (!candidate) {
    return;
  }
  const notBefore = Number((candidate.options as Record<string, unknown> | undefined)?.__notBefore ?? 0);
  if (notBefore > Date.now()) {
    return;
  }

  // Захватываем, не удаляя: строка покидает таблицу только после подтверждённой
  // передачи prompt агенту (markDelivered на якоре). Пока она захвачена, обход
  // её не видит — одной строкой две отправки не случится.
  const next = chatMessageQueueDb.claim(candidate.id) ? candidate : null;
  if (!next) {
    // Строку увёл параллельный проход/«Сейчас» — её повезёт он.
    return;
  }
  broadcastChatQueue(sessionId);

  let started = false;
  try {
    started = await runner(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Очередь чата] не удалось отправить сообщение из очереди', { sessionId, error: message });
  }

  if (started) {
    return;
  }

  // Запуск завести не вышло (место занято, вход закрыт) — возвращаем захват:
  // это НЕ неудача доставки, счётчик попыток не растёт.
  chatMessageQueueDb.releaseClaim(next.id);
  broadcastChatQueue(sessionId);
}

/**
 * Обходит очереди и отправляет первое сообщение каждого свободного чата.
 *
 * Обходим ВСЕ чаты с очередью, а не только тот, чей ход закончился: сообщение
 * могло ждать не своего хода, а свободного места (предел одновременных чатов),
 * и освободилось оно именно сейчас.
 */
export function dispatchChatQueues(): void {
  sweepRequested = true;
  if (sweeping) {
    return;
  }
  sweeping = true;

  void (async () => {
    try {
      while (sweepRequested) {
        sweepRequested = false;
        // Осиротевшие захваты: строку пометили, а ход, который её вёз, исчез
        // нештатно — без finally. При живом ходе не трогаем: захват правомерен
        // весь запуск (от прямой отправки до якоря бывают минуты).
        for (const claimedSessionId of chatMessageQueueDb.sessionsWithClaims()) {
          if (
            !chatRunRegistry.isProcessing(claimedSessionId)
            && chatMessageQueueDb.releaseStaleClaims(claimedSessionId, ORPHAN_CLAIM_MS) > 0
          ) {
            broadcastChatQueue(claimedSessionId);
          }
        }
        for (const sessionId of chatMessageQueueDb.sessionsWithQueue()) {
          await dispatchSession(sessionId);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Очередь чата] обход очередей прервался', message);
    } finally {
      sweeping = false;
    }
  })();
}

/**
 * Страховка: обход очередей раз в минуту.
 *
 * Конец хода — основной сигнал, но он может не прийти (агент пережил
 * перезапуск сайта, запуск оборвался нештатно). Сообщение человека не должно
 * зависеть от того, случился ли ровно один нужный сигнал: раз в минуту сервер
 * сам смотрит, не освободился ли чат с очередью. Цена — один короткий запрос
 * к маленькой таблице.
 */
const QUEUE_SWEEP_INTERVAL_MS = 60_000;
/**
 * Захват без живого хода старше этого срока считается осиротевшим и
 * снимается сторожем. Якорь (передача prompt) занимает секунды-минуты; 3
 * минуты — запас против патологически медленной сборки хода.
 */
const ORPHAN_CLAIM_MS = 3 * 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startChatQueueHeartbeat(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    dispatchChatQueues();
  }, QUEUE_SWEEP_INTERVAL_MS);
  // Держать процесс живым ради обхода очередей не нужно.
  sweepTimer.unref?.();
}
