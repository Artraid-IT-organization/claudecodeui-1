import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readSelectedDevinConnectionId,
  selectChatProvider,
  selectDevinConnection,
  switchChatProvider,
} from './providerSelection';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function withBrowserGlobals(run: (events: string[], storage: MemoryStorage) => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const target = new EventTarget();
  const storage = new MemoryStorage();
  const events: string[] = [];
  target.addEventListener('ccui:continue-in-provider', (event) => {
    events.push(String((event as CustomEvent).detail));
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    run(events, storage);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test('provider selection: silent synchronization stores provider without requesting navigation', () => {
  withBrowserGlobals((events, storage) => {
    selectChatProvider('devin');

    assert.equal(storage.getItem('selected-provider'), 'devin');
    assert.deepEqual(events, []);
  });
});

test('provider selection: explicit Claude, Codex and Devin choices request navigation once', () => {
  withBrowserGlobals((events, storage) => {
    switchChatProvider('claude');
    switchChatProvider('codex');
    switchChatProvider('devin');

    assert.equal(storage.getItem('selected-provider'), 'devin');
    assert.deepEqual(events, ['claude', 'codex', 'devin']);
  });
});

test('provider selection: choosing a Devin subscription stores it and requests Devin navigation', () => {
  withBrowserGlobals((events, storage) => {
    selectDevinConnection(42);

    assert.equal(storage.getItem('selected-devin-connection'), '42');
    assert.equal(readSelectedDevinConnectionId(), 42);
    assert.equal(storage.getItem('selected-provider'), 'devin');
    assert.deepEqual(events, ['devin']);
  });
});
