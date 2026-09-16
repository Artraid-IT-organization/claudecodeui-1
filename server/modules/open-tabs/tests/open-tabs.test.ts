import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { normalizeOpenTabs, openTabsDb } from '@/modules/database/repositories/open-tabs.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'open-tabs-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const userId = (username: string): number => Number(
  getConnection().prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')").run(username).lastInsertRowid,
);

test('вкладки у каждого пользователя свои, версия растёт только при изменении', async () => {
  await withIsolatedDatabase(() => {
    const egor = userId('egor');
    const other = userId('other');
    assert.deepEqual(openTabsDb.get(egor), { version: 0, tabs: [], updatedAt: null });

    const first = openTabsDb.put(egor, [{ sessionId: 'a', title: 'А' }, { sessionId: 'b' }]);
    assert.equal(first.version, 1);
    assert.equal(openTabsDb.put(egor, [{ sessionId: 'a', title: 'А' }, { sessionId: 'b' }]).version, 1);

    const reordered = openTabsDb.put(egor, [{ sessionId: 'b' }, { sessionId: 'a', title: 'А' }]);
    assert.equal(reordered.version, 2);
    assert.deepEqual(reordered.tabs.map((t) => t.sessionId), ['b', 'a']);
    assert.deepEqual(openTabsDb.get(other).tabs, []);
  });
});

test('список чистится: повторы, пустые, лишние поля', () => {
  assert.deepEqual(
    normalizeOpenTabs([{ sessionId: 'a', junk: 1 }, { sessionId: 'a' }, { sessionId: '' }, null, { sessionId: 'b', provider: 'claude' }]),
    [{ sessionId: 'a' }, { sessionId: 'b', provider: 'claude' }],
  );
  assert.deepEqual(normalizeOpenTabs('nope'), []);
});
