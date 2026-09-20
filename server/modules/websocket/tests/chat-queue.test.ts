import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chatMessageQueueDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, onChatRunCompleted } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  clearChatQueue,
  dispatchChatQueues,
  listChatQueue,
  queueChatMessage,
  removeChatQueueItem,
  reorderChatQueue,
  setQueuedChatMessageRunner,
} from '@/modules/websocket/services/chat-queue.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Очередь сообщений чата живёт на сервере и отправляется по концу хода —
 * без открытой вкладки. Проверяем именно это: ни одного подключения к
 * серверу в этих проверках нет.
 */

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-queue-'));
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

/** Даём асинхронному обходу очередей дойти до конца. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('очередь переживает перезапуск: строки лежат в базе, а не в памяти', async () => {
  await withIsolatedDatabase(() => {
    queueChatMessage({ id: 'm1', sessionId: 'chat-1', userId: '1', content: 'первое', options: {} });
    queueChatMessage({ id: 'm2', sessionId: 'chat-1', userId: '1', content: 'второе', options: {} });

    const stored = chatMessageQueueDb.list('chat-1');
    assert.deepEqual(stored.map((item) => item.content), ['первое', 'второе']);
    // Повтор той же строки (телефон досылает неподтверждённое) очередь не удваивает.
    queueChatMessage({ id: 'm1', sessionId: 'chat-1', userId: '1', content: 'первое', options: {} });
    assert.equal(chatMessageQueueDb.list('chat-1').length, 2);
  });
});

test('конец хода отправляет следующее сообщение очереди без единой открытой вкладки', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('chat-2', 'claude', '/workspace/demo');

    const sent: string[] = [];
    setQueuedChatMessageRunner(async (message) => {
      sent.push(message.content);
      return true;
    });
    onChatRunCompleted(() => {
      dispatchChatQueues();
    });

    const run = chatRunRegistry.startRun({
      appSessionId: 'chat-2',
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: '1',
    });
    assert.ok(run);

    queueChatMessage({ id: 'q1', sessionId: 'chat-2', userId: '1', content: 'следующее', options: {} });
    queueChatMessage({ id: 'q2', sessionId: 'chat-2', userId: '1', content: 'за ним', options: {} });

    // Пока ход идёт — ничего не уходит.
    dispatchChatQueues();
    await settle();
    assert.deepEqual(sent, []);

    // Ход закончился: уходит ровно одно, первое; второе ждёт своего конца хода.
    connectedClients.clear();
    run.writer.sendComplete({ exitCode: 0 });
    await settle();
    assert.deepEqual(sent, ['следующее']);
    assert.deepEqual(listChatQueue('chat-2').map((item) => item.content), ['за ним']);
  });
});

test('не заведённый запуск возвращает сообщение в начало очереди, а не теряет его', async () => {
  await withIsolatedDatabase(async () => {
    setQueuedChatMessageRunner(async () => false);

    queueChatMessage({ id: 'w1', sessionId: 'chat-3', userId: '1', content: 'ждёт места', options: {} });
    queueChatMessage({ id: 'w2', sessionId: 'chat-3', userId: '1', content: 'за ним', options: {} });

    dispatchChatQueues();
    await settle();

    assert.deepEqual(listChatQueue('chat-3').map((item) => item.content), ['ждёт места', 'за ним']);
  });
});

test('правка очереди: убрать строку, переставить порядок, очистить', async () => {
  await withIsolatedDatabase(() => {
    queueChatMessage({ id: 'e1', sessionId: 'chat-4', userId: '1', content: 'раз', options: {} });
    queueChatMessage({ id: 'e2', sessionId: 'chat-4', userId: '1', content: 'два', options: {} });
    queueChatMessage({ id: 'e3', sessionId: 'chat-4', userId: '1', content: 'три', options: {} });

    reorderChatQueue('chat-4', ['e3', 'e1', 'e2']);
    assert.deepEqual(listChatQueue('chat-4').map((item) => item.content), ['три', 'раз', 'два']);

    removeChatQueueItem('chat-4', 'e1');
    assert.deepEqual(listChatQueue('chat-4').map((item) => item.content), ['три', 'два']);

    clearChatQueue('chat-4');
    assert.deepEqual(listChatQueue('chat-4'), []);
  });
});

test('вложения сообщения доезжают до очереди и видны странице', async () => {
  await withIsolatedDatabase(() => {
    queueChatMessage({
      id: 'a1',
      sessionId: 'chat-5',
      userId: '1',
      content: 'со снимком',
      options: { attachments: [{ path: 'shot.png', name: 'shot.png', mimeType: 'image/png' }] },
    });

    const [item] = listChatQueue('chat-5');
    assert.equal(item?.content, 'со снимком');
    assert.equal(item?.attachments.length, 1);
  });
});

test('пустой обход не залипает: следующая очередь всё равно уходит', async () => {
  await withIsolatedDatabase(async () => {
    const sent: string[] = [];
    setQueuedChatMessageRunner(async (message) => {
      sent.push(message.content);
      return true;
    });

    // Так делает сервер при подъёме: очередей ещё нет, обход заканчивается
    // мгновенно. Раньше после этого признак «обход идёт» оставался включённым
    // навсегда, и очередь больше не отправлялась никогда.
    dispatchChatQueues();
    await settle();

    queueChatMessage({ id: 'h1', sessionId: 'chat-6', userId: '1', content: 'после пустого обхода', options: {} });
    dispatchChatQueues();
    await settle();

    assert.deepEqual(sent, ['после пустого обхода']);
  });
});
