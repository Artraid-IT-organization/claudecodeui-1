import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTH_RETRY_MAX_MS, nextAuthRetryDelay } from './authRetry';

test('первая попытка ждёт базовую паузу', () => {
  assert.equal(nextAuthRetryDelay(0), 5_000);
});

test('пауза растёт вдвое с каждой неудачей', () => {
  assert.equal(nextAuthRetryDelay(1), 10_000);
  assert.equal(nextAuthRetryDelay(2), 20_000);
});

test('пауза упирается в потолок и дальше не растёт', () => {
  assert.equal(nextAuthRetryDelay(3), AUTH_RETRY_MAX_MS);
  assert.equal(nextAuthRetryDelay(50), AUTH_RETRY_MAX_MS);
  // Именно потолок держит экран живым: без него к вечеру повтор ждал бы часами.
  assert.ok(nextAuthRetryDelay(1000) <= AUTH_RETRY_MAX_MS);
});

test('мусор на входе не ломает расчёт', () => {
  assert.equal(nextAuthRetryDelay(-5), 5_000);
  assert.equal(nextAuthRetryDelay(Number.NaN), 5_000);
  assert.equal(nextAuthRetryDelay(1.7), 10_000);
});
