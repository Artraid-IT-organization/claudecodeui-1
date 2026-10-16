import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { claimReloadTarget, reloadOrMarkPending } from './appUpdate';

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

test('marks a new build without reloading the page', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  let reloads = 0;
  const pending: string[] = [];

  reloadOrMarkPending(storage, 'bundle-target', 'index-new.js', () => { reloads += 1; }, (target) => pending.push(target));

  assert.equal(reloads, 0);
  assert.deepEqual(pending, ['index-new.js']);
});

test('never reloads when cached and network index alternate', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  let reloads = 0;
  const pending: string[] = [];
  const reload = () => { reloads += 1; };
  const mark = (target: string) => pending.push(target);

  reloadOrMarkPending(storage, 'bundle-target', 'index-a.js', reload, mark);
  reloadOrMarkPending(storage, 'bundle-target', 'index-b.js', reload, mark);
  reloadOrMarkPending(storage, 'bundle-target', 'index-a.js', reload, mark);
  reloadOrMarkPending(storage, 'bundle-target', 'index-b.js', reload, mark);

  assert.equal(reloads, 0);
  assert.deepEqual(pending, ['index-a.js', 'index-b.js', 'index-a.js', 'index-b.js']);
});

test('service worker reports a stale page without navigating clients', () => {
  const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /client\.navigate\(client\.url\)/);
  assert.doesNotMatch(source, /setInterval\(/);
  assert.match(source, /postMessage\(\{ type: 'sw:stale-page' \}\)/);
});

test('shows the update instead of reloading when storage is blocked', () => {
  const blockedStorage = {
    getItem: () => { throw new Error('Access denied'); },
    setItem: () => { throw new Error('Access denied'); },
  };
  let reloads = 0;
  const pending: string[] = [];

  reloadOrMarkPending(blockedStorage, 'bundle-target', 'index-new.js', () => { reloads += 1; }, (target) => pending.push(target));
  reloadOrMarkPending(blockedStorage, 'sw-target', 'service-worker', () => { reloads += 1; }, (target) => pending.push(target));

  assert.equal(reloads, 0);
  assert.deepEqual(pending, ['index-new.js', 'service-worker']);
});
