import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, devinConnectionsDb, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { devinConnectionsService, classifyDevinFailure } from '@/modules/providers/services/devin-connections.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'devin-conn-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

test('connection selection: lowest priority first, disabled skipped', async () => {
  await withIsolatedDatabase(() => {
    devinConnectionsDb.create({ name: 'a-low', priority: 10, xdgDataHome: '/tmp/xdg-a' });
    const bHigh = devinConnectionsDb.create({ name: 'b-high', priority: 0, xdgDataHome: '/tmp/xdg-b' });
    const picked = devinConnectionsDb.pickAvailable();
    assert.equal(picked?.id, bHigh.id);
  });
});

test('connection selection: disabled and auth_failed are not eligible', async () => {
  await withIsolatedDatabase(() => {
    const dead = devinConnectionsDb.create({ name: 'dead', priority: 0, xdgDataHome: '/tmp/xdg-dead' });
    devinConnectionsDb.update(dead.id, { enabled: false });
    const failing = devinConnectionsDb.create({ name: 'failing', priority: 1, xdgDataHome: '/tmp/xdg-fail' });
    devinConnectionsDb.markHealth(failing.id, 'auth_failed', { lastError: 'Authentication required' });
    const alive = devinConnectionsDb.create({ name: 'alive', priority: 2, xdgDataHome: '/tmp/xdg-alive' });
    assert.equal(devinConnectionsDb.pickAvailable()?.id, alive.id);
  });
});

test('connection selection: cooldown skips until it expires', async () => {
  await withIsolatedDatabase(async () => {
    const limited = devinConnectionsDb.create({ name: 'limited', priority: 0, xdgDataHome: '/tmp/xdg-l' });
    devinConnectionsDb.markHealth(limited.id, 'rate_limited', { cooldownMinutes: 15 });
    assert.equal(devinConnectionsDb.pickAvailable(), null);
    // Имитируем истёкший cooldown напрямую в базе — канал снова годен.
    getConnection().prepare("UPDATE devin_connections SET cooldown_until = datetime('now', '-1 minute') WHERE id = ?").run(limited.id);
    assert.equal(devinConnectionsDb.pickAvailable()?.id, limited.id);
  });
});

test('pickAvailableExcluding excludes already-tried connections', async () => {
  await withIsolatedDatabase(() => {
    const first = devinConnectionsDb.create({ name: 'first', priority: 0, xdgDataHome: '/tmp/xdg-1' });
    const second = devinConnectionsDb.create({ name: 'second', priority: 1, xdgDataHome: '/tmp/xdg-2' });
    assert.equal(devinConnectionsDb.pickAvailableExcluding([first.id])?.id, second.id);
    assert.equal(devinConnectionsDb.pickAvailableExcluding([first.id, second.id]), null);
  });
});

test('session binding: setSessionDevinConnection persists link', async () => {
  await withIsolatedDatabase(() => {
    const conn = devinConnectionsDb.create({ name: 'bound', xdgDataHome: '/tmp/xdg-bound' });
    sessionsDb.createAppSession('app-1', 'devin', '/tmp/proj');
    sessionsDb.setSessionDevinConnection('app-1', conn.id);
    assert.equal(sessionsDb.getSessionById('app-1')?.devin_connection_id, conn.id);
    // Список задач канала видит этот чат.
    const tasks = devinConnectionsDb.listBoundSessions(conn.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].session_id, 'app-1');
  });
});

test('classifyDevinFailure: auth vs rate-limit vs transient', () => {
  assert.equal(classifyDevinFailure('Authentication required'), 'auth');
  assert.equal(classifyDevinFailure('Invalid service key'), 'auth');
  assert.equal(classifyDevinFailure('HTTP 429 Too Many Requests'), 'rate_limit');
  assert.equal(classifyDevinFailure('rate limit exceeded'), 'rate_limit');
  assert.equal(classifyDevinFailure('connection reset by peer'), 'transient');
});

test('pickConnection throws AppError when nothing is available', async () => {
  await withIsolatedDatabase(async () => {
    // XDG_DATA_HOME в пустой временный каталог → машинной креды «нет» → посев
    // не создаёт default-канал → честная 503. (На этом хосте креда реальна.)
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = await mkdtemp(path.join(tmpdir(), 'devin-xdg-empty-'));
    try {
      assert.throws(
        () => devinConnectionsService.pickConnection(),
        (error: unknown) => (error as { code?: string }).code === 'DEVIN_CONNECTION_UNAVAILABLE',
      );
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
    }
  });
});
