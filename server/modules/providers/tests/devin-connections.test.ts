import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('pickConnection: chosen channel wins over priority when eligible', async () => {
  await withIsolatedDatabase(() => {
    devinConnectionsDb.create({ name: 'first', priority: 0, xdgDataHome: '/tmp/xdg-p1' });
    const chosen = devinConnectionsDb.create({ name: 'chosen', priority: 5, xdgDataHome: '/tmp/xdg-p2' });
    assert.equal(devinConnectionsService.pickConnection([], chosen.id).id, chosen.id);
  });
});

test('pickConnection: chosen channel in cooldown or already tried falls back to priority', async () => {
  await withIsolatedDatabase(() => {
    const top = devinConnectionsDb.create({ name: 'top', priority: 0, xdgDataHome: '/tmp/xdg-f1' });
    const limited = devinConnectionsDb.create({ name: 'limited', priority: 1, xdgDataHome: '/tmp/xdg-f2' });
    devinConnectionsDb.markHealth(limited.id, 'rate_limited', { cooldownMinutes: 15 });
    const spare = devinConnectionsDb.create({ name: 'spare', priority: 2, xdgDataHome: '/tmp/xdg-f3' });
    assert.equal(devinConnectionsService.pickConnection([], limited.id).id, top.id);
    assert.equal(devinConnectionsService.pickConnection([top.id], top.id).id, spare.id);
  });
});

test('pickConnection: all channels cooling down — still picks the one that recovers first, never blocks SWE', async () => {
  await withIsolatedDatabase(() => {
    const first = devinConnectionsDb.create({ name: 'first', priority: 0, xdgDataHome: '/tmp/xdg-c1' });
    const second = devinConnectionsDb.create({ name: 'second', priority: 1, xdgDataHome: '/tmp/xdg-c2' });
    devinConnectionsDb.markHealth(first.id, 'rate_limited', { cooldownMinutes: 720 });
    devinConnectionsDb.markHealth(second.id, 'rate_limited', { cooldownMinutes: 360 });
    // 22.10.26: обе на паузе → берётся та, что вернётся раньше (second), а не отказ 503.
    assert.equal(devinConnectionsService.pickConnection().id, second.id);
    // Уже перепробованная в этом ходе исключается, как и раньше.
    assert.equal(devinConnectionsService.pickConnection([second.id]).id, first.id);
    // Все перепробованы — отказ остаётся (повторять некуда).
    assert.throws(
      () => devinConnectionsService.pickConnection([first.id, second.id]),
      (error: unknown) => (error as { code?: string }).code === 'DEVIN_CONNECTION_UNAVAILABLE',
    );
    // Годная подписка без паузы по-прежнему идёт раньше любой на паузе.
    const ready = devinConnectionsDb.create({ name: 'ready', priority: 5, xdgDataHome: '/tmp/xdg-c3' });
    assert.equal(devinConnectionsService.pickConnection().id, ready.id);
    // Отозванная креда и админское выключение — настоящие запреты, их пауза-обход не касается.
    devinConnectionsDb.markHealth(ready.id, 'auth_failed', { lastError: 'x' });
    assert.equal(devinConnectionsService.pickConnection().id, second.id);
    getConnection().prepare('UPDATE devin_connections SET enabled = 0 WHERE id IN (?, ?)').run(first.id, second.id);
    assert.throws(
      () => devinConnectionsService.pickConnection(),
      (error: unknown) => (error as { code?: string }).code === 'DEVIN_CONNECTION_UNAVAILABLE',
    );
  });
});

test('classifyDevinFailure: hex trace ID with "403" inside is still a rate limit, not auth', () => {
  const live = 'Reached free model rate limit. Your limit will reset in 34 minutes (at 21:01 UTC). (trace ID: afd89c403f6c84cbe2c1)';
  assert.equal(classifyDevinFailure(live), 'rate_limit');
  // Живой хвост из журнала: тайминг `time.busy=403µs` после trace ID (бывший local-patch 0010).
  const limitWithTrace = 'Devin run failed: Reached free model rate limit. Your limit will reset in 45 seconds. (trace ID: 294c57b83d29bb7b9cbcc12271cffef5) — INFO chisel_agent::acp_server: close time.busy=403µs time.idle=1.33s';
  assert.equal(classifyDevinFailure(limitWithTrace), 'rate_limit');
  assert.equal(classifyDevinFailure('HTTP 403 Forbidden'), 'auth');
  assert.equal(
    classifyDevinFailure("Session 'sequoia-hearing' is already open in another process (PID 291819). Close the other instance before opening it here."),
    'session_locked',
  );
});

test('recordOutcome: rate limit cools the subscription down until the reset time Devin names', async () => {
  await withIsolatedDatabase(() => {
    const conn = devinConnectionsDb.create({ name: 'limited', xdgDataHome: '/tmp/xdg-cool' });
    const reset = new Date(Date.now() + 47 * 60_000);
    const hhmm = `${String(reset.getUTCHours()).padStart(2, '0')}:${String(reset.getUTCMinutes()).padStart(2, '0')}`;
    devinConnectionsService.recordOutcome(conn.id, 'failed', `Reached free model rate limit. Your limit will reset in 47 minutes (at ${hhmm} UTC).`);
    const row = devinConnectionsDb.getById(conn.id)!;
    assert.equal(row.health_status, 'rate_limited');
    const cooldownMinutes = (Date.parse(`${row.cooldown_until!.replace(' ', 'T')}Z`) - Date.now()) / 60_000;
    assert.ok(cooldownMinutes > 44 && cooldownMinutes <= 48, `cooldown ≈ 47 min, got ${cooldownMinutes}`);
  });
});

test('recordOutcome: usage quota of paid models does not pause the subscription; plain limits do, repeats double it', async () => {
  await withIsolatedDatabase(() => {
    const conn = devinConnectionsDb.create({ name: 'weekly', xdgDataHome: '/tmp/xdg-weekly' });
    const minutes = (id: number) => {
      const row = devinConnectionsDb.getById(id)!;
      return (Date.parse(`${row.cooldown_until!.replace(' ', 'T')}Z`) - Date.now()) / 60_000;
    };
    // 22.10.26: квота платных моделей не ставит паузу — бесплатные SWE-2 на этой подписке работают.
    devinConnectionsService.recordOutcome(conn.id, 'failed', 'Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage (trace ID: abc)');
    devinConnectionsService.recordOutcome(conn.id, 'failed', 'Your daily usage quota has been exhausted.');
    const quotaRow = devinConnectionsDb.getById(conn.id)!;
    assert.equal(quotaRow.cooldown_until, null);
    assert.notEqual(quotaRow.health_status, 'rate_limited');
    assert.equal(devinConnectionsDb.isEligible(conn.id), true);
    // Обычный лимит без срока — короткий отдых, повтор — удвоенный.
    const daily = devinConnectionsDb.create({ name: 'daily', xdgDataHome: '/tmp/xdg-daily' });
    devinConnectionsService.recordOutcome(daily.id, 'failed', 'Reached free model rate limit.');
    assert.ok(minutes(daily.id) > 14 && minutes(daily.id) <= 16, `plain ≈ 15 min, got ${minutes(daily.id)}`);
    getConnection().prepare("UPDATE devin_connections SET cooldown_until = datetime('now', '-1 minute') WHERE id = ?").run(daily.id);
    devinConnectionsService.recordOutcome(daily.id, 'failed', 'Reached free model rate limit.');
    assert.ok(minutes(daily.id) > 29 && minutes(daily.id) <= 31, `repeated plain ≈ 30 min, got ${minutes(daily.id)}`);
  });
});

test('pickCredentialForLane: picker choice → lane own credential → any eligible', async () => {
  await withIsolatedDatabase(() => {
    const lane = devinConnectionsDb.create({ name: 'lane', priority: 5, xdgDataHome: '/tmp/xdg-lane' });
    const top = devinConnectionsDb.create({ name: 'top', priority: 0, xdgDataHome: '/tmp/xdg-top' });
    const chosen = devinConnectionsDb.create({ name: 'chosen', priority: 9, xdgDataHome: '/tmp/xdg-chosen' });
    assert.equal(devinConnectionsService.pickCredentialForLane(lane, [], chosen.id).id, chosen.id);
    assert.equal(devinConnectionsService.pickCredentialForLane(lane).id, lane.id);
    // Своя подписка линии исчерпана — платит первая годная по приоритету.
    devinConnectionsDb.markHealth(lane.id, 'rate_limited', { cooldownMinutes: 30 });
    assert.equal(devinConnectionsService.pickCredentialForLane(lane).id, top.id);
    assert.equal(devinConnectionsService.pickCredentialForLane(lane, [top.id]).id, chosen.id);
    // Выключенная линия остаётся линией (resolveLaneForSession), но не платит.
    devinConnectionsDb.update(lane.id, { enabled: false });
    assert.equal(devinConnectionsService.resolveLaneForSession(lane.id).id, lane.id);
  });
});

test('prepareTurnDataHome: shadow XDG mirrors the lane and carries the subscription credential', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'devin-overlay-'));
  const previousRoot = process.env.DEVIN_CONNECTIONS_ROOT;
  process.env.DEVIN_CONNECTIONS_ROOT = path.join(root, 'connections');
  try {
    await withIsolatedDatabase(async () => {
      const laneXdg = path.join(root, 'lane');
      const credXdg = path.join(root, 'cred');
      await mkdir(path.join(laneXdg, 'devin', 'cli'), { recursive: true });
      await mkdir(path.join(laneXdg, 'notebooklm-mcp'), { recursive: true });
      await writeFile(path.join(laneXdg, 'devin', 'cli', 'sessions.db'), 'LANE-DB');
      await writeFile(path.join(laneXdg, 'devin', 'credentials.toml'), 'windsurf_api_key = "lane"\n');
      await mkdir(path.join(credXdg, 'devin'), { recursive: true });
      await writeFile(path.join(credXdg, 'devin', 'credentials.toml'), 'windsurf_api_key = "cred"\n');
      const lane = devinConnectionsDb.create({ name: 'lane', xdgDataHome: laneXdg });
      const credential = devinConnectionsDb.create({ name: 'cred', xdgDataHome: credXdg });

      assert.equal(devinConnectionsService.prepareTurnDataHome(lane, lane), laneXdg, 'own credential — no shadow');

      const shadow = devinConnectionsService.prepareTurnDataHome(lane, credential);
      assert.notEqual(shadow, laneXdg);
      assert.equal(await readFile(path.join(shadow, 'devin', 'cli', 'sessions.db'), 'utf8'), 'LANE-DB');
      assert.match(await readFile(path.join(shadow, 'devin', 'credentials.toml'), 'utf8'), /"cred"/);
      assert.ok((await lstat(path.join(shadow, 'notebooklm-mcp'))).isSymbolicLink(), 'other XDG apps mirrored');

      // Запись через тень попадает в линию.
      await writeFile(path.join(shadow, 'devin', 'cli', 'new-lock'), 'x');
      assert.equal(await readFile(path.join(laneXdg, 'devin', 'cli', 'new-lock'), 'utf8'), 'x');

      // Созданное процессом прямо в тени возвращается в линию при следующей сборке.
      await mkdir(path.join(shadow, 'fresh-mcp'));
      await writeFile(path.join(shadow, 'fresh-mcp', 'state.json'), '{}');
      devinConnectionsService.prepareTurnDataHome(lane, credential);
      assert.equal(await readFile(path.join(laneXdg, 'fresh-mcp', 'state.json'), 'utf8'), '{}');
      assert.ok((await lstat(path.join(shadow, 'fresh-mcp'))).isSymbolicLink());

      // Креду, переписанную CLI настоящим файлом, получает её подписка, ссылка — восстанавливается.
      await rm(path.join(shadow, 'devin', 'credentials.toml'));
      await writeFile(path.join(shadow, 'devin', 'credentials.toml'), 'windsurf_api_key = "cred-refreshed"\n');
      devinConnectionsService.prepareTurnDataHome(lane, credential);
      assert.match(await readFile(path.join(credXdg, 'devin', 'credentials.toml'), 'utf8'), /cred-refreshed/);
      assert.ok((await lstat(path.join(shadow, 'devin', 'credentials.toml'))).isSymbolicLink());
      assert.match(await readFile(path.join(laneXdg, 'devin', 'credentials.toml'), 'utf8'), /"lane"/, 'lane credential untouched');
    });
  } finally {
    if (previousRoot === undefined) delete process.env.DEVIN_CONNECTIONS_ROOT; else process.env.DEVIN_CONNECTIONS_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
