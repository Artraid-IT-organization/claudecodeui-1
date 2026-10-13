import assert from 'node:assert/strict';
import test from 'node:test';

import { claimReloadTarget } from './appUpdate';

test('claims a new build once and blocks a reload loop for the same build', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };

  assert.equal(claimReloadTarget(storage, 'reload-target', 'index-new.js'), true);
  assert.equal(claimReloadTarget(storage, 'reload-target', 'index-new.js'), false);
  assert.equal(claimReloadTarget(storage, 'reload-target', 'index-newer.js'), true);
});

test('does not reload when Brave or private mode blocks session storage', () => {
  const blockedStorage = {
    getItem: () => { throw new Error('Access denied'); },
    setItem: () => { throw new Error('Access denied'); },
  };

  assert.equal(claimReloadTarget(blockedStorage, 'reload-target', 'index-new.js'), false);
});

test('does not reload when the guard write is silently discarded', () => {
  const discardedStorage = {
    getItem: () => null,
    setItem: () => undefined,
  };

  assert.equal(claimReloadTarget(discardedStorage, 'reload-target', 'index-new.js'), false);
});
