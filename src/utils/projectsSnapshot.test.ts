import assert from 'node:assert/strict';
import test from 'node:test';

// Хранилище браузера подменяется простой картой — в node его нет.
const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => { memory.set(key, String(value)); },
  removeItem: (key: string) => { memory.delete(key); },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() { return memory.size; },
} as Storage;

const { readProjectsSnapshot, writeProjectsSnapshot } = await import('./projectsSnapshot');

const b64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const tokenFor = (userId: number) =>
  `${b64url({ alg: 'HS256' })}.${b64url({ userId, iat: 1, exp: 2 })}.sig`;

const projects = (names: string[]) =>
  names.map((name) => ({ projectId: name, displayName: name })) as never[];

test('без токена снимок не читается и не пишется', () => {
  memory.clear();
  writeProjectsSnapshot(projects(['proj-a']));
  assert.equal(memory.size, 0);
  assert.equal(readProjectsSnapshot(), null);
});

test('снимок пишется и читается под ключом владельца токена', () => {
  memory.clear();
  memory.set('auth-token', tokenFor(7));
  writeProjectsSnapshot(projects(['proj-a', 'proj-b']));
  assert.deepEqual(
    (readProjectsSnapshot() as { projectId: string }[]).map((p) => p.projectId),
    ['proj-a', 'proj-b'],
  );
  assert.ok(memory.has('ccui-projects:7'));
});

test('другой пользователь не видит чужой снимок', () => {
  memory.clear();
  memory.set('auth-token', tokenFor(7));
  writeProjectsSnapshot(projects(['proj-a']));
  memory.set('auth-token', tokenFor(3));
  assert.equal(readProjectsSnapshot(), null);
});

test('пустой список стирает снимок, а не хранит его', () => {
  memory.clear();
  memory.set('auth-token', tokenFor(7));
  writeProjectsSnapshot(projects(['proj-a']));
  writeProjectsSnapshot([]);
  assert.equal(memory.has('ccui-projects:7'), false);
  assert.equal(readProjectsSnapshot(), null);
});

test('битое содержимое ключа читается как отсутствие снимка', () => {
  memory.clear();
  memory.set('auth-token', tokenFor(7));
  memory.set('ccui-projects:7', 'not-json');
  assert.equal(readProjectsSnapshot(), null);
  memory.set('ccui-projects:7', '{"projects":"nope"}');
  assert.equal(readProjectsSnapshot(), null);
});

test('токен не-JWT формы не даёт ключа', () => {
  memory.clear();
  memory.set('auth-token', 'plain-token');
  writeProjectsSnapshot(projects(['proj-a']));
  assert.equal(memory.size, 1); // только сам токен
});
