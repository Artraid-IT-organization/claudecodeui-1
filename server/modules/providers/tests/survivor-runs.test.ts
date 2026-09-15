import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  adoptSurvivors,
  isSurvivorRunning,
  markShuttingDown,
  noteSurvivorProviderSession,
  pollSurvivors,
  resetSurvivorsForTests,
  spawnSurvivableClaude,
  stopSurvivor,
} from '@/modules/providers/list/claude/survivor-runs.js';

// «Агент»-заглушка: в строке запуска те же слова, что у настоящего claude, —
// по ним модуль отличает агента от чужой программы с тем же PID.
function fakeAgent(lifetimeMs: number) {
  return {
    command: process.execPath,
    args: ['-e', `setTimeout(() => {}, ${lifetimeMs})`, 'claude', '--output-format', 'stream-json'],
    env: process.env,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await check();
}

async function withLiveDir(runTest: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-runs-'));
  const previous = process.env.CLOUDCLI_LIVE_RUNS_DIR;
  process.env.CLOUDCLI_LIVE_RUNS_DIR = dir;
  resetSurvivorsForTests();
  try {
    await runTest(dir);
  } finally {
    resetSurvivorsForTests();
    if (previous === undefined) delete process.env.CLOUDCLI_LIVE_RUNS_DIR;
    else process.env.CLOUDCLI_LIVE_RUNS_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('при остановке сервера уборка SDK не убивает агента, новый сервер его находит и может остановить', async () => {
  await withLiveDir(async (dir) => {
    const child = spawnSurvivableClaude(fakeAgent(60000), { appSessionId: 'chat-1' });
    const files = await readdir(dir);
    assert.equal(files.length, 1, 'запись о запуске появилась');
    const pid = Number(files[0].replace('.json', ''));

    markShuttingDown();
    assert.equal(child.kill('SIGTERM'), false, 'во время остановки «убить» ничего не делает');
    assert.equal(alive(pid), true);

    const adopted = adoptSurvivors({ pollMs: 0 });
    assert.deepEqual(adopted.map((run) => run.sessionId), ['chat-1']);
    assert.equal(isSurvivorRunning('chat-1'), true);

    assert.equal(stopSurvivor('chat-1'), true);
    assert.equal(await waitFor(() => !alive(pid)), true, '«Стоп» останавливает пережившего агента');
    assert.equal(isSurvivorRunning('chat-1'), false);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('обычное завершение агента убирает запись, мёртвые записи не усыновляются', async () => {
  await withLiveDir(async (dir) => {
    const child = spawnSurvivableClaude(fakeAgent(200), { appSessionId: 'chat-2' });
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(await waitFor(async () => (await readdir(dir)).length === 0), true);
    assert.deepEqual(adoptSurvivors({ pollMs: 0 }), []);
  });
});

test('когда переживший агент закончил, сервер узнаёт об этом', async () => {
  await withLiveDir(async () => {
    const child = spawnSurvivableClaude(fakeAgent(700), { appSessionId: 'chat-3', configDir: '/nonexistent' });
    noteSurvivorProviderSession('chat-3', 'provider-3');
    markShuttingDown();
    adoptSurvivors({ pollMs: 0 });
    assert.equal(isSurvivorRunning('chat-3'), true);

    await new Promise((resolve) => child.once('exit', resolve));
    const gone: string[] = [];
    pollSurvivors({ onGone: (id: string) => gone.push(id) });
    assert.deepEqual(gone, ['chat-3']);
    assert.equal(isSurvivorRunning('chat-3'), false);
  });
});

test('новый процесс того же разговора гасит прежний, если тот не ушёл сам', async () => {
  await withLiveDir(async () => {
    const previousGrace = process.env.CLOUDCLI_STALE_RUN_GRACE_MS;
    process.env.CLOUDCLI_STALE_RUN_GRACE_MS = '200';
    try {
      const stale = spawnSurvivableClaude(fakeAgent(60000), { appSessionId: 'chat-4', providerSessionId: 'provider-4' });
      const other = spawnSurvivableClaude(fakeAgent(60000), { appSessionId: 'chat-5', providerSessionId: 'provider-5' });
      const fresh = spawnSurvivableClaude(fakeAgent(60000), { appSessionId: 'chat-4', providerSessionId: 'provider-4' });

      const exited = await new Promise<boolean>((resolve) => {
        stale.once('exit', () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      });
      assert.equal(exited, true, 'прежний процесс разговора остановлен');

      let otherExited = false;
      other.once('exit', () => { otherExited = true; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(otherExited, false, 'чужой разговор не тронут');

      fresh.kill('SIGTERM');
      other.kill('SIGTERM');
    } finally {
      if (previousGrace === undefined) delete process.env.CLOUDCLI_STALE_RUN_GRACE_MS;
      else process.env.CLOUDCLI_STALE_RUN_GRACE_MS = previousGrace;
    }
  });
});
