import assert from 'node:assert/strict';
import test from 'node:test';

import { knownRunStartedAt, noteRun } from './liveRunCursor';

// Повторяет проверку из useChatRealtimeHandlers: событие принимается, только
// если его номер больше запомненного для чата.
function accept(sid: string, event: { seq: number; runStartedAt?: number }, lastSeq: Map<string, number>): boolean {
  noteRun(sid, event.runStartedAt, lastSeq);
  const known = lastSeq.get(sid) ?? 0;
  if (event.seq <= known) return false;
  lastSeq.set(sid, event.seq);
  return true;
}

test('события новой работы не выбрасываются как уже виденные', () => {
  const lastSeq = new Map<string, number>();
  // Долгая прошлая работа: вкладка дошла до номера 2000.
  assert.equal(accept('chat', { seq: 2000, runStartedAt: 111 }, lastSeq), true);
  // Новая работа начинает нумерацию с 1 — раньше это событие терялось.
  assert.equal(accept('chat', { seq: 1, runStartedAt: 222 }, lastSeq), true);
  assert.equal(accept('chat', { seq: 2, runStartedAt: 222 }, lastSeq), true);
  assert.equal(knownRunStartedAt('chat'), 222);
});

test('повтор события той же работы по-прежнему отбрасывается', () => {
  const lastSeq = new Map<string, number>();
  assert.equal(accept('chat-2', { seq: 5, runStartedAt: 333 }, lastSeq), true);
  assert.equal(accept('chat-2', { seq: 5, runStartedAt: 333 }, lastSeq), false);
  assert.equal(accept('chat-2', { seq: 4, runStartedAt: 333 }, lastSeq), false);
});

test('событие без метки работы не сбрасывает счётчик', () => {
  const lastSeq = new Map<string, number>();
  assert.equal(accept('chat-3', { seq: 10, runStartedAt: 444 }, lastSeq), true);
  assert.equal(accept('chat-3', { seq: 3 }, lastSeq), false);
});
