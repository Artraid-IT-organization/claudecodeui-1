import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatOutbox,
  OUTBOX_ENTRY_TTL_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STORAGE_KEY,
  OUTBOX_SLOT_WAIT_TTL_MS,
  SLOT_RETRY_MS,
} from './chatOutbox';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

const send = (content: string) => ({ type: 'chat.send', sessionId: 's1', content });

test('сообщение получает постоянный номер и лежит в очереди до расписки', () => {
  const storage = memoryStorage();
  const outbox = new ChatOutbox(storage);
  const entry = outbox.add(send('привет'));
  assert.ok(entry.id.length >= 8);
  assert.equal(entry.message.clientMessageId, entry.id);
  assert.equal(outbox.size, 1);

  outbox.markSent(entry.id);
  outbox.markSent(entry.id);
  assert.equal(outbox.pending()[0].message.clientMessageId, entry.id, 'повтор идёт с тем же номером');

  assert.equal(outbox.settle(entry.id), true);
  assert.equal(outbox.size, 0);
  assert.equal(storage.data.has(OUTBOX_STORAGE_KEY), false);
});

test('очередь переживает перезагрузку страницы', () => {
  const storage = memoryStorage();
  const first = new ChatOutbox(storage);
  const entry = first.add(send('не потеряйся'));
  first.markSent(entry.id);

  const reloaded = new ChatOutbox(storage);
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.pending()[0].id, entry.id);
  assert.equal(reloaded.pending()[0].message.content, 'не потеряйся');
});

test('без расписки дольше срока сообщение считается просроченным', () => {
  let now = 1_000;
  const outbox = new ChatOutbox(memoryStorage(), () => now);
  const entry = outbox.add(send('a'));
  assert.deepEqual(outbox.overdue(10_000), [], 'не отправленное не просрочено');
  outbox.markSent(entry.id);
  now += 9_999;
  assert.deepEqual(outbox.overdue(10_000), []);
  now += 1;
  assert.equal(outbox.overdue(10_000).length, 1);
});

test('исчерпав попытки или срок, сообщение отдаётся на честный отказ', () => {
  let now = 0;
  const outbox = new ChatOutbox(memoryStorage(), () => now);
  const tired = outbox.add(send('попытки'));
  for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) outbox.markSent(tired.id);
  const old = outbox.add(send('срок'));
  assert.deepEqual(outbox.takeGivenUp(10_000), [], 'расписку ещё ждём');

  now = 10_000;
  assert.deepEqual(outbox.takeGivenUp(10_000).map((e) => e.id), [tired.id]);

  now = OUTBOX_ENTRY_TTL_MS;
  assert.deepEqual(outbox.takeGivenUp(10_000).map((e) => e.id), [old.id]);
  assert.equal(outbox.size, 0);
});

test('чужая расписка и повторная постановка того же номера ничего не ломают', () => {
  const outbox = new ChatOutbox(memoryStorage());
  const entry = outbox.add({ ...send('x'), clientMessageId: 'fixed-id-123' });
  assert.equal(entry.id, 'fixed-id-123');
  assert.equal(outbox.add({ ...send('x'), clientMessageId: 'fixed-id-123' }), entry);
  assert.equal(outbox.settle('unknown-id'), false);
  assert.equal(outbox.settle(undefined), false);
  assert.equal(outbox.size, 1);
});

test('«чат занят» от старого сервера снимает сообщения этого чата, чужие остаются', () => {
  const outbox = new ChatOutbox(memoryStorage());
  outbox.add({ type: 'chat.send', sessionId: 'busy', content: '1' });
  outbox.add({ type: 'chat.send', sessionId: 'busy', content: '2' });
  const other = outbox.add({ type: 'chat.send', sessionId: 'other', content: '3' });
  assert.equal(outbox.settleSession('busy').length, 2);
  assert.deepEqual(outbox.pending().map((e) => e.id), [other.id]);
  assert.equal(outbox.settleSession('nobody').length, 0);
});

test('отказ «предел одновременных чатов» не выбрасывает сообщение: оно ждёт и повторяется', () => {
  let now = 1_000;
  const storage = memoryStorage();
  const outbox = new ChatOutbox(storage, () => now);
  const first = outbox.add(send('первое'));
  outbox.markSent(first.id);

  assert.equal(outbox.markWaitingForSlot(first.id), true, 'о начале ожидания говорится один раз');
  assert.equal(outbox.size, 1);
  assert.deepEqual(outbox.overdue(10_000), [], 'ждущее места не считается потерянной связью');
  assert.deepEqual(outbox.dueSlotRetries(SLOT_RETRY_MS), [], 'повтор не сразу');

  now += SLOT_RETRY_MS;
  assert.deepEqual(outbox.dueSlotRetries(SLOT_RETRY_MS).map((e) => e.id), [first.id]);
  outbox.markSent(first.id);
  assert.deepEqual(outbox.dueSlotRetries(SLOT_RETRY_MS), [], 'отправленное ждёт ответа, а не шлётся второй раз');
  assert.equal(outbox.markWaitingForSlot(first.id), false, 'повторный отказ — без второго пояснения');

  const reloaded = new ChatOutbox(storage, () => now);
  assert.equal(reloaded.isWaitingForSlot(first.id), true, 'ожидание переживает перезагрузку');

  now += OUTBOX_ENTRY_TTL_MS + 60_000;
  assert.deepEqual(outbox.takeGivenUp(10_000), [], 'ожидание места дольше двух часов не превращается в «не дошло»');
  assert.equal(outbox.settle(first.id), true, 'сервер принял — сообщение уходит из очереди');
});

test('новое сообщение чата встаёт за ждущим места и уходит после него', () => {
  let now = 1_000;
  const outbox = new ChatOutbox(memoryStorage(), () => now);
  const first = outbox.add(send('первое'));
  outbox.markWaitingForSlot(first.id);
  assert.equal(outbox.hasWaitingInSession('s1'), true);
  assert.equal(outbox.hasWaitingInSession('s2'), false);

  now += 1;
  const second = outbox.add(send('второе'));
  outbox.markWaitingForSlot(second.id);
  const other = outbox.add({ type: 'chat.send', sessionId: 's2', content: 'другой чат' });
  outbox.markWaitingForSlot(other.id);

  assert.equal(outbox.isQueuedBehindInSession(first), false);
  assert.equal(outbox.isQueuedBehindInSession(second), true);
  now += SLOT_RETRY_MS;
  assert.deepEqual(outbox.dueSlotRetries(SLOT_RETRY_MS).map((e) => e.id), [first.id, other.id], 'по одному на чат, самое раннее');

  outbox.settle(first.id);
  assert.deepEqual(outbox.dueSlotRetries(SLOT_RETRY_MS).map((e) => e.id), [second.id, other.id]);
});

test('ждущее места сообщение сдаётся только после долгого срока', () => {
  let now = 1_000;
  const outbox = new ChatOutbox(memoryStorage(), () => now);
  const entry = outbox.add(send('a'));
  outbox.markWaitingForSlot(entry.id);
  now += OUTBOX_SLOT_WAIT_TTL_MS;
  assert.deepEqual(outbox.takeGivenUp(10_000).map((e) => e.id), [entry.id]);
});
