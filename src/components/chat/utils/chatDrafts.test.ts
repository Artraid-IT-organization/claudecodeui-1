import assert from 'node:assert/strict';
import test from 'node:test';

// Хранилище браузера подменяется простой картой: помощники черновика ходят в
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
  adoptLegacyProjectDraft,
  clearDraftInput,
  draftInputKey,
  draftScopeFor,
  readDraftInput,
  writeDraftInput,
} = await import('./chatStorage');

test('черновик открытого чата принадлежит чату, а не проекту', () => {
  assert.equal(draftScopeFor('proj-1', 'chat-a'), 'chat-a');
  assert.equal(draftScopeFor('proj-1', 'chat-b'), 'chat-b');
});

test('у нового чата до первой отправки черновик живёт в области проекта', () => {
  assert.equal(draftScopeFor('proj-1', null), 'project:proj-1');
  assert.equal(draftScopeFor(null, null), null);
});

test('ключ сохраняет прежний префикс — его находит очистка хранилища', () => {
  assert.ok(draftInputKey('chat-a').startsWith('draft_input_'));
});

test('два чата одного проекта не видят текст друг друга', () => {
  memory.clear();
  writeDraftInput('chat-a', 'черновик А');
  assert.equal(readDraftInput('chat-b'), '');
  writeDraftInput('chat-b', 'черновик Б');
  assert.equal(readDraftInput('chat-a'), 'черновик А');
  assert.equal(readDraftInput('chat-b'), 'черновик Б');
});

test('пустой текст убирает черновик, очистка трогает только свой чат', () => {
  memory.clear();
  writeDraftInput('chat-a', 'черновик А');
  writeDraftInput('chat-b', 'черновик Б');
  writeDraftInput('chat-a', '');
  assert.equal(memory.has(draftInputKey('chat-a')), false);
  clearDraftInput('chat-b');
  assert.equal(readDraftInput('chat-b'), '');
});

test('старый черновик проекта переезжает в открытый чат один раз', () => {
  memory.clear();
  memory.set('draft_input_proj-1', 'текст до обновления');
  adoptLegacyProjectDraft('proj-1', 'chat-a');
  assert.equal(readDraftInput('chat-a'), 'текст до обновления');
  assert.equal(memory.has('draft_input_proj-1'), false);
  adoptLegacyProjectDraft('proj-1', 'chat-b');
  assert.equal(readDraftInput('chat-b'), '');
});

test('перенос старого черновика не перетирает свой черновик чата', () => {
  memory.clear();
  memory.set('draft_input_proj-1', 'старый');
  writeDraftInput('chat-a', 'свой');
  adoptLegacyProjectDraft('proj-1', 'chat-a');
  assert.equal(readDraftInput('chat-a'), 'свой');
  assert.equal(memory.has('draft_input_proj-1'), false);
});
