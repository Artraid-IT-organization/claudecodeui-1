import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChatOutbox,
  OUTBOX_ENTRY_TTL_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STORAGE_KEY,
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
