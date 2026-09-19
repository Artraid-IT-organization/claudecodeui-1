import assert from 'node:assert/strict';
import test from 'node:test';

// Хранилище браузера подменяется простой картой: помощники очереди ходят в
// него через safeLocalStorage, а в node его нет.
const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => { memory.set(key, String(value)); },
  removeItem: (key: string) => { memory.delete(key); },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() { return memory.size; },
} as Storage;

const {
  appendQueuedMessage,
  clearQueuedMessages,
  queuedMessageKey,
  queuedMessagesKey,
  readQueuedMessages,
  shiftQueuedMessage,
  writeQueuedMessages,
} = await import('./chatStorage');

test('сообщения встают в очередь друг за другом и не затирают прежние', () => {
  memory.clear();
  appendQueuedMessage('chat-a', { content: 'первое' });
  appendQueuedMessage('chat-a', { content: 'второе' });
  appendQueuedMessage('chat-a', { content: 'третье' });

  assert.deepEqual(readQueuedMessages('chat-a').map((m) => m.content), ['первое', 'второе', 'третье']);
});

test('у каждого сообщения свой устойчивый ключ — им двигают и правят строку', () => {
  memory.clear();
  appendQueuedMessage('chat-a', { content: 'первое' });
  appendQueuedMessage('chat-a', { content: 'второе' });

  const ids = readQueuedMessages('chat-a').map((m) => m.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => typeof id === 'string' && id));
  assert.notEqual(ids[0], ids[1]);
  // Перечитали — ключи те же, иначе перенос строки терял бы цель.
  assert.deepEqual(readQueuedMessages('chat-a').map((m) => m.id), ids);
});

test('снятие отдаёт первое и оставляет остаток — это «талон» от двойной отправки', () => {
  memory.clear();
  appendQueuedMessage('chat-a', { content: 'первое' });
  appendQueuedMessage('chat-a', { content: 'второе' });

  assert.equal(shiftQueuedMessage('chat-a')?.content, 'первое');
  assert.deepEqual(readQueuedMessages('chat-a').map((m) => m.content), ['второе']);
  assert.equal(shiftQueuedMessage('chat-a')?.content, 'второе');
  assert.equal(shiftQueuedMessage('chat-a'), null);
});

test('порядок после переноса строки сохраняется в хранилище', () => {
  memory.clear();
  appendQueuedMessage('chat-a', { content: 'первое' });
  appendQueuedMessage('chat-a', { content: 'второе' });
  const all = readQueuedMessages('chat-a');
  writeQueuedMessages('chat-a', [all[1], all[0]]);

  assert.deepEqual(readQueuedMessages('chat-a').map((m) => m.content), ['второе', 'первое']);
  assert.equal(shiftQueuedMessage('chat-a')?.content, 'второе');
});

test('очереди разных чатов не смешиваются', () => {
  memory.clear();
  appendQueuedMessage('chat-a', { content: 'для А' });
  appendQueuedMessage('chat-b', { content: 'для Б' });

  assert.deepEqual(readQueuedMessages('chat-a').map((m) => m.content), ['для А']);
  assert.deepEqual(readQueuedMessages('chat-b').map((m) => m.content), ['для Б']);
});

test('сообщение, поставленное в очередь прошлой сборкой, не теряется', () => {
  memory.clear();
  memory.set(queuedMessageKey('chat-a'), JSON.stringify({ content: 'старый формат', options: { model: 'opus' } }));

  const restored = readQueuedMessages('chat-a');
  assert.deepEqual(restored.map((m) => m.content), ['старый формат']);
  assert.deepEqual(restored[0].options, { model: 'opus' });
  // Перенесено в новый ключ, старый убран — второй раз не всплывёт.
  assert.equal(memory.get(queuedMessageKey('chat-a')), undefined);
  assert.ok(memory.get(queuedMessagesKey('chat-a')));
});

test('давний «сырой текст» тоже переносится, а не уходит в чат как есть', () => {
  memory.clear();
  memory.set(queuedMessageKey('chat-a'), 'просто текст');
  assert.deepEqual(readQueuedMessages('chat-a').map((m) => m.content), ['просто текст']);
});

test('пустая очередь не оставляет за собой ключей', () => {
  memory.clear();
  appendQueuedMessage('chat-a', { content: 'одно' });
  clearQueuedMessages('chat-a');
  assert.deepEqual(readQueuedMessages('chat-a'), []);
  assert.equal(memory.get(queuedMessagesKey('chat-a')), undefined);
});

test('пустое сообщение без вложений в очередь не попадает', () => {
  memory.clear();
  writeQueuedMessages('chat-a', [{ content: '   ' }, { content: 'настоящее' }]);
  assert.deepEqual(readQueuedMessages('chat-a').map((m) => m.content), ['настоящее']);
});
