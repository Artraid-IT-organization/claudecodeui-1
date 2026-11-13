import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceStreamStore } from '../voice-stream-store.js';

const store = (overrides: Partial<Parameters<typeof createVoiceStreamStore>[0]> = {}) =>
  createVoiceStreamStore({ maxTotalBytes: 100, ttlMs: 60_000, sweepIntervalMs: 60_000, ...overrides });

test('glues chunks in arrival order and take() frees the session', () => {
  const s = store();
  assert.equal(s.append('stream-12345', Buffer.from('aaa'), 'audio/webm'), 'ok');
  assert.equal(s.append('stream-12345', Buffer.from('bbb'), 'audio/webm'), 'ok');
  const taken = s.take('stream-12345');
  assert.equal(taken?.bytes.toString(), 'aaabbb');
  assert.equal(taken?.mimeType, 'audio/webm');
  assert.equal(s.take('stream-12345'), undefined);
  s.stop();
});

test('rejects oversized recordings and bad stream ids', () => {
  const s = store();
  assert.equal(s.append('short', Buffer.from('x'), 'audio/webm'), 'bad-sid');
  assert.equal(s.append('stream-12345', Buffer.alloc(60), 'audio/webm'), 'ok');
  assert.equal(s.append('stream-12345', Buffer.alloc(60), 'audio/webm'), 'too-big');
  s.stop();
});

test('a session abandoned past ttl is swept away', () => {
  let now = 1_000;
  const s = createVoiceStreamStore({ maxTotalBytes: 100, ttlMs: 500, sweepIntervalMs: 10, now: () => now });
  assert.equal(s.append('stream-12345', Buffer.from('x'), 'audio/webm'), 'ok');
  now += 1_000;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(s.size(), 0);
      s.stop();
      resolve();
    }, 30);
  });
});

test('discard removes a cancelled stream', () => {
  const s = store();
  s.append('stream-12345', Buffer.from('x'), 'audio/webm');
  s.discard('stream-12345');
  assert.equal(s.size(), 0);
  s.stop();
});
