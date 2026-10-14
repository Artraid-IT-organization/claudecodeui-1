import assert from 'node:assert/strict';
import test from 'node:test';

// Хранилище браузера подменяется простой картой — как в chatDrafts.test.ts.
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
  appendPendingSend,
  clearPendingSends,
  listPendingSends,
  removePendingSend,
  stampPendingSession,
} = await import('./pendingSessionSends');

const rec = (id: string, sessionId: string | null = null) => ({
  id,
  content: `текст ${id}`,
  attachments: [],
  options: {} as never,
  provider: 'claude' as const,
  projectPath: '/tmp/proj',
  summary: null,
  sessionId,
  createdAt: Date.now(),
});

test('записи копятся в порядке отправки и читаются обратно', () => {
  memory.clear();
  appendPendingSend('project:p1', rec('a'));
  appendPendingSend('project:p1', rec('b'));
  const list = listPendingSends('project:p1');
  assert.deepEqual(list.map((r) => r.id), ['a', 'b']);
});

test('очереди разных областей не смешиваются', () => {
  memory.clear();
  appendPendingSend('project:p1', rec('a'));
  appendPendingSend('project:p2', rec('b'));
  assert.deepEqual(listPendingSends('project:p1').map((r) => r.id), ['a']);
  assert.deepEqual(listPendingSends('project:p2').map((r) => r.id), ['b']);
});

test('stamp проставляет сессию только записям без неё', () => {
  memory.clear();
  appendPendingSend('project:p1', rec('a', 'sess-old'));
  appendPendingSend('project:p1', rec('b'));
  stampPendingSession('project:p1', 'sess-new');
  const list = listPendingSends('project:p1');
  assert.equal(list[0].sessionId, 'sess-old');
  assert.equal(list[1].sessionId, 'sess-new');
});

test('remove убирает одну запись, остальные остаются', () => {
  memory.clear();
  appendPendingSend('project:p1', rec('a'));
  appendPendingSend('project:p1', rec('b'));
  appendPendingSend('project:p1', rec('c'));
  removePendingSend('project:p1', 'b');
  assert.deepEqual(listPendingSends('project:p1').map((r) => r.id), ['a', 'c']);
});

test('clear сносит очередь целиком; пустая область читается пустой', () => {
  memory.clear();
  appendPendingSend('project:p1', rec('a'));
  clearPendingSends('project:p1');
  assert.deepEqual(listPendingSends('project:p1'), []);
  assert.deepEqual(listPendingSends(null), []);
});

test('битое содержимое ключа не роняет чтение', () => {
  memory.clear();
  memory.set('pending_session_sends_project:p1', '{битое');
  assert.deepEqual(listPendingSends('project:p1'), []);
});
