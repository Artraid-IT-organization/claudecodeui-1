import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chatMessageQueueDb, chatRunsDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, reconcilePersistedRuns } from '@/modules/websocket/services/chat-run-registry.service.js';
import { listChatQueue } from '@/modules/websocket/services/chat-queue.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Журнал ходов (chat_runs) — терминальный исход хода на диске.
 *
 * Проверяем класс «молчаливый обрыв»: ход помечался «running» только в
 * памяти сервера, и смерть процесса оставляла ленту без конца и без
 * причины. Теперь исход переживает сервер, а сверка при подъёме закрывает
 * осиротевшие строки и возвращает недошедшие сообщения в очередь.
 */

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-runs-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('ход пишется в журнал при старте и закрывается терминальным статусом', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('jr-1', 'devin', '/workspace/demo');

    const run = chatRunRegistry.startRun({
      appSessionId: 'jr-1',
      provider: 'devin',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: '1',
      pendingMessage: { id: 'm-1', userId: '1', content: 'сделай', options: {} },
    });
    assert.ok(run);

    const running = chatRunsDb.runningForSession('jr-1');
    assert.equal(running?.status, 'running');
    assert.equal(running?.pending?.content, 'сделай');

    chatRunRegistry.markRunPromptAnchored(run);
    assert.equal(chatRunsDb.runningForSession('jr-1')?.pending, null);
    assert.equal(chatRunsDb.runningForSession('jr-1')?.promptAnchored, true);

    run.writer.sendComplete({ exitCode: 0 });
    const finished = chatRunsDb.latestFinishedForSession('jr-1');
    assert.equal(finished?.status, 'completed');
    assert.ok(finished?.finishedAt);
  });
});

test('падение хода пишет причину — плашке есть что показать после перезагрузки', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('jr-2', 'devin', '/workspace/demo');
    const run = chatRunRegistry.startRun({
      appSessionId: 'jr-2',
      provider: 'devin',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: '1',
    });
    assert.ok(run);

    chatRunRegistry.noteRunFailure(run, 'У Devin кончился лимит бесплатной модели');
    run.writer.sendComplete({ exitCode: 1 });

    const finished = chatRunsDb.latestFinishedForSession('jr-2');
    assert.equal(finished?.status, 'failed');
    assert.equal(finished?.error, 'У Devin кончился лимит бесплатной модели');
  });
});

test('остановка человеком — не ошибка: исход «aborted», без текста ошибки', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('jr-3', 'claude', '/workspace/demo');
    const run = chatRunRegistry.startRun({
      appSessionId: 'jr-3',
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: '1',
    });
    assert.ok(run);
    run.writer.sendComplete({ exitCode: 0, aborted: true });
    assert.equal(chatRunsDb.latestFinishedForSession('jr-3')?.status, 'aborted');
  });
});

test('сверка при старте: «running» без живого процесса — обрыв, сообщение обратно в очередь', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('jr-4', 'devin', '/workspace/demo');
    // Так выглядит строка хода, умершего вместе с прошлым сервером в середине
    // сборки: journal есть, процесса нет, сообщение ещё не у агента.
    chatRunsDb.begin({
      runId: 'run-dead-1',
      sessionId: 'jr-4',
      provider: 'devin',
      pending: { id: 'lost-9', userId: '1', content: 'не доехало', options: {} },
    });

    const closed = reconcilePersistedRuns();

    assert.equal(closed, 1);
    const finished = chatRunsDb.latestFinishedForSession('jr-4');
    assert.equal(finished?.status, 'interrupted');
    assert.ok(finished?.error);
    // Сообщение вернулось в очередь и уйдёт обычным обходом после подъёма.
    assert.deepEqual(listChatQueue('jr-4').map((item) => item.id), ['lost-9']);
  });
});

test('сверка не трогает заякоренный ход и не дублирует вернувшееся сообщение', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('jr-5', 'devin', '/workspace/demo');
    chatRunsDb.begin({
      runId: 'run-dead-2',
      sessionId: 'jr-5',
      provider: 'devin',
      pending: { id: 'back-1', userId: '1', content: 'уже в очереди', options: {} },
    });
    // Штатное гашение уже вернуло строку до смерти сервера.
    chatMessageQueueDb.append({ id: 'back-1', sessionId: 'jr-5', userId: '1', content: 'уже в очереди', options: {} });

    const closed = reconcilePersistedRuns();
    assert.equal(closed, 1);
    // INSERT OR IGNORE по id — копии в очереди нет.
    assert.equal(listChatQueue('jr-5').length, 1);
  });
});

test('сверка не трогает живой ход, который уже в реестре', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('jr-6', 'devin', '/workspace/demo');
    const run = chatRunRegistry.startRun({
      appSessionId: 'jr-6',
      provider: 'devin',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: '1',
    });
    assert.ok(run);

    const closed = reconcilePersistedRuns();
    assert.equal(closed, 0);
    assert.equal(chatRunsDb.runningForSession('jr-6')?.status, 'running');
  });
});

test('сторож: ход «running» с мёртвым процессом закрывается с видимой причиной', async (t) => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('jr-7', 'claude', '/workspace/demo');
    const conn = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'jr-7',
      provider: 'claude',
      providerSessionId: null,
      connection: conn,
      userId: '1',
    });
    assert.ok(run);

    // Имитация «умер молча»: процесс по записи live-runs погиб, а поток
    // промиса не отчитался. Старт сдвигаем за грейс сторожа.
    run.startedAt = Date.now() - 120_000;
    run.promptAnchored = true;
    run.lastActivityAt = Date.now() - 60_000;

    // Пишем мёртвую запись live-runs вручную: pid, которого точно нет.
    const liveDir = process.env.CLOUDCLI_LIVE_RUNS_DIR ?? path.join(tmpdir(), `live-runs-${Date.now()}`);
    process.env.CLOUDCLI_LIVE_RUNS_DIR = liveDir;
    const fs = await import('node:fs');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, '999999.json'), JSON.stringify({
      pid: 999999,
      provider: 'claude',
      appSessionId: 'jr-7',
      startedAt: Date.now(),
    }));
    t.after(() => { delete process.env.CLOUDCLI_LIVE_RUNS_DIR; });

    // Обход сторожа — напрямую (интервал в тесте не ждём).
    const { sweepRunsOnceForTests } = await import('@/modules/websocket/services/chat-run-registry.service.js') as typeof import('@/modules/websocket/services/chat-run-registry.service.js') & { sweepRunsOnceForTests: () => void };
    sweepRunsOnceForTests();

    assert.equal(run.status, 'completed');
    const finished = chatRunsDb.latestFinishedForSession('jr-7');
    assert.equal(finished?.status, 'failed');
    assert.ok(finished?.error?.includes('молча'));
    // Вкладке ушли видимая ошибка и complete.
    assert.ok(conn.frames.some((frame) => frame.kind === 'error'));
    assert.ok(conn.frames.some((frame) => frame.kind === 'complete'));
  });
});
