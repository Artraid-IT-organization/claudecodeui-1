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
  returnClaimedToQueue,
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

test('ход, не доехавший до агента, возвращает захваченную строку — не сгорает', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('chat-loss', 'devin', '/workspace/demo');
    queueChatMessage({ id: 'lost-1', sessionId: 'chat-loss', userId: '1', content: 'не доехало', options: {} });
    const claimed = chatMessageQueueDb.claimFirst('chat-loss');
    assert.ok(claimed);

    // Так заканчивается ход, упавший до session/prompt (session_locked от
    // выжившего процесса): finally хода возвращает захват — строка снова
    // свободна, у неё счётчик попыток и пауза до следующей.
    const outcome = returnClaimedToQueue(claimed, 'session_locked');
    assert.equal(outcome, 'requeued');

    const [item] = chatMessageQueueDb.list('chat-loss');
    assert.equal(item?.content, 'не доехало');
    assert.equal(item?.claimedAt, null);
    assert.equal((item?.options as Record<string, unknown>).__redispatch, 1);
    assert.ok(Number((item?.options as Record<string, unknown>).__notBefore) > Date.now());
  });
});

test('возвращённое сообщение ждёт отметки не-раньше, а не крутится подряд', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('chat-hold', 'devin', '/workspace/demo');
    sessionsDb.createAppSession('chat-hold-2', 'devin', '/workspace/demo');

    const sent: string[] = [];
    setQueuedChatMessageRunner(async (message) => {
      sent.push(message.content);
      return true;
    });

    queueChatMessage({
      id: 'hold-1',
      sessionId: 'chat-hold',
      userId: '1',
      content: 'рано ещё',
      options: { __notBefore: Date.now() + 60_000 },
    });
    queueChatMessage({
      id: 'go-1',
      sessionId: 'chat-hold-2',
      userId: '1',
      content: 'пора',
      options: { __notBefore: Date.now() - 1_000 },
    });

    dispatchChatQueues();
    await settle();

    // Отложенная строка осталась в очереди свободной и первой, прошедшая
    // отметку — захвачена и ушла.
    assert.deepEqual(sent, ['пора']);
    const [held] = chatMessageQueueDb.list('chat-hold');
    assert.equal(held?.content, 'рано ещё');
    assert.equal(held?.claimedAt, null);
  });
});

test('дошедшее до агента сообщение обратно в очередь не возвращается', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('chat-anchored', 'devin', '/workspace/demo');
    queueChatMessage({ id: 'anch-1', sessionId: 'chat-anchored', userId: '1', content: 'у агента', options: {} });
    const claimed = chatMessageQueueDb.claimFirst('chat-anchored');
    assert.ok(claimed);
    const run = chatRunRegistry.startRun({
      appSessionId: 'chat-anchored',
      provider: 'devin',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: '1',
      pendingMessage: { id: 'anch-1', userId: '1', content: 'у агента', options: {} },
    });
    assert.ok(run);
    chatRunRegistry.markRunPromptAnchored(run);

    // Якорь снял строку и забыл сообщение хода — возвращать нечего, дубля нет.
    assert.equal(run.pendingMessage, null);
    assert.equal(chatMessageQueueDb.list('chat-anchored').length, 0);
  });
});

test('после предела повторов сообщение не исчезает — видимая ошибка в очереди', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('chat-tired', 'devin', '/workspace/demo');
    queueChatMessage({
      id: 'tired-1',
      sessionId: 'chat-tired',
      userId: '1',
      content: 'уже пробовали',
      options: { __redispatch: 29 },
    });
    const claimed = chatMessageQueueDb.claimFirst('chat-tired');
    assert.ok(claimed);

    const outcome = returnClaimedToQueue(claimed, 'session_locked');
    assert.equal(outcome, 'failed');

    // Строка остаётся и честно говорит «не дошло»: человек решает — повторить
    // («Сейчас»), поправить или убрать. Тихого удаления нет.
    const [item] = chatMessageQueueDb.list('chat-tired');
    assert.equal(item?.state, 'failed');
    assert.ok(item?.lastError?.includes('30'));
    assert.deepEqual(chatMessageQueueDb.sessionsWithQueue(), []);
  });
});

test('остановка до доставки снимает сообщение и со строки — повторной отправки нет', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('chat-abort', 'devin', '/workspace/demo');
    // Прямая отправка: write-ahead строка захвачена ходом.
    chatMessageQueueDb.appendClaimedLast({
      id: 'stop-1', sessionId: 'chat-abort', userId: '1', content: 'отменено человеком', options: {},
    });
    const run = chatRunRegistry.startRun({
      appSessionId: 'chat-abort',
      provider: 'devin',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: '1',
      pendingMessage: { id: 'stop-1', userId: '1', content: 'отменено человеком', options: {} },
    });
    assert.ok(run);

    // Так делает chat.abort: человек остановил доставку — ход и очередь её забыли.
    run.pendingMessage = null;
    chatMessageQueueDb.remove('chat-abort', 'stop-1');

    assert.equal(chatMessageQueueDb.list('chat-abort').length, 0);
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

/**
 * Регрессия 14.10.26 — тихая потеря сообщений очереди.
 *
 * Живой случай: три сообщения встали в очередь чата 13fa2cd9, обход при
 * подъёме сервера снял строку до подхвата выжившего агента, запуск упёрся в
 * session_locked и `.catch` просто логировал — строки исчезли без следа.
 * Держимый теперь контракт: строка уходит из таблицы только после подтверждённой
 * передачи prompt агенту (якорь) или по явной воле человека.
 */

test('захват строки НЕ удаляет её: падение процесса между захватом и якорем не теряет сообщение', async () => {
  await withIsolatedDatabase(async () => {
    queueChatMessage({ id: 'c1', sessionId: 'chat-10', userId: '1', content: 'живёт в базе', options: {} });

    const claimed = chatMessageQueueDb.claimFirst('chat-10');
    assert.ok(claimed);
    assert.ok(claimed.claimedAt);

    // Строка на месте, просто помечена захваченной — док её не показывает,
    // обход её не трогает.
    assert.equal(chatMessageQueueDb.list('chat-10').length, 1);
    assert.deepEqual(listChatQueue('chat-10'), []);
    assert.deepEqual(chatMessageQueueDb.sessionsWithQueue(), []);

    // «Процесс умер» — подъём снимает захваты прошлого поколения.
    chatMessageQueueDb.releaseAllClaims();
    assert.deepEqual(chatMessageQueueDb.sessionsWithQueue(), ['chat-10']);
    assert.equal(listChatQueue('chat-10').length, 1);
  });
});

test('не заведённый запуск возвращает захват БЕЗ счётчика: это не неудача доставки', async () => {
  await withIsolatedDatabase(async () => {
    setQueuedChatMessageRunner(async () => false);

    queueChatMessage({ id: 'n1', sessionId: 'chat-11', userId: '1', content: 'занято место', options: {} });
    dispatchChatQueues();
    await settle();

    const [row] = chatMessageQueueDb.list('chat-11');
    assert.equal(row.claimedAt, null);
    assert.equal(row.state, 'queued');
    assert.equal(row.options.__redispatch ?? 0, 0);
  });
});

test('падение хода до якоря возвращает строку со счётчиком, а после всех попыток — видимая ошибка', async () => {
  await withIsolatedDatabase(async () => {
    queueChatMessage({ id: 'f1', sessionId: 'chat-12', userId: '1', content: 'до агента не дошло', options: {} });
    const claimed = chatMessageQueueDb.claimFirst('chat-12');
    assert.ok(claimed);

    // Первый сбой доставки: строка возвращается, попытка засчитана.
    const outcome = returnClaimedToQueue(claimed, 'session_locked');
    assert.equal(outcome, 'requeued');
    let [row] = chatMessageQueueDb.list('chat-12');
    assert.equal(row.claimedAt, null);
    assert.equal(row.state, 'queued');
    assert.equal(row.options.__redispatch, 1);
    assert.equal(listChatQueue('chat-12').length, 1);

    // 30-я попытка — потолок: строка остаётся, но честно помечена ошибкой.
    for (let attempt = 2; attempt <= 30; attempt += 1) {
      const again = chatMessageQueueDb.claimFirst('chat-12');
      assert.ok(again, `попытка ${attempt}: строка должна быть доступна обходу`);
      returnClaimedToQueue(again, 'session_locked');
    }
    [row] = chatMessageQueueDb.list('chat-12');
    assert.equal(row.state, 'failed');
    assert.ok(row.lastError?.includes('не дошло до агента'));

    // В доке — видимая ошибка, а не исчезнувшая строка.
    const [view] = listChatQueue('chat-12');
    assert.ok(view.error);

    // Отказавшую строку обход больше не трогает: дальше решает человек.
    assert.deepEqual(chatMessageQueueDb.sessionsWithQueue(), []);
  });
});

test('якорь снимает строку с очереди: markRunPromptAnchored хода с pendingMessage', async () => {
  await withIsolatedDatabase(async () => {
    queueChatMessage({ id: 'a1', sessionId: 'chat-13', userId: '1', content: 'доехало', options: {} });
    const claimed = chatMessageQueueDb.claimFirst('chat-13');
    assert.ok(claimed);

    const run = chatRunRegistry.startRun({
      appSessionId: 'chat-13',
      provider: 'claude',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: '1',
      pendingMessage: {
        id: claimed.id,
        userId: '1',
        content: claimed.content,
        options: claimed.options,
      },
    });
    assert.ok(run);

    chatRunRegistry.markRunPromptAnchored(run);
    assert.equal(run.promptAnchored, true);
    assert.equal(run.pendingMessage, null);
    assert.equal(chatMessageQueueDb.list('chat-13').length, 0);
  });
});

test('гашение сервера возвращает незаякоренные сообщения в очередь без счётчика', async () => {
  await withIsolatedDatabase(async () => {
    // Прямая отправка: строка write-ahead в хвосте, захваченная запуском.
    chatMessageQueueDb.appendClaimedLast({
      id: 's1', sessionId: 'chat-14', userId: '1', content: 'прямая отправка', options: {},
    });

    const run = chatRunRegistry.startRun({
      appSessionId: 'chat-14',
      provider: 'devin',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: '1',
      pendingMessage: { id: 's1', userId: '1', content: 'прямая отправка', options: {} },
    });
    assert.ok(run);

    const requeued = chatRunRegistry.requeueUnanchoredRuns();
    assert.equal(requeued, 1);

    const [row] = chatMessageQueueDb.list('chat-14');
    assert.equal(row.claimedAt, null);
    assert.equal(row.state, 'queued');
    assert.equal(row.options.__redispatch ?? 0, 0);
    assert.equal(listChatQueue('chat-14').length, 1);
  });
});

test('захваченная обходом строка не уходит дважды: второй обход её не видит', async () => {
  await withIsolatedDatabase(async () => {
    const sent: string[] = [];
    setQueuedChatMessageRunner(async (message) => {
      sent.push(message.content);
      // Держим «запуск» открытым: захваченная строка в базе, ход якобы идёт.
      return true;
    });

    queueChatMessage({ id: 'd1', sessionId: 'chat-15', userId: '1', content: 'один раз', options: {} });
    dispatchChatQueues();
    dispatchChatQueues();
    await settle();

    assert.deepEqual(sent, ['один раз']);
    // Строка ждёт своего якоря — обходы мимо неё проходят.
    assert.deepEqual(chatMessageQueueDb.sessionsWithQueue(), []);
  });
});

test('осиротевший захват без живого хода сторож снимает и строка снова видна', async () => {
  await withIsolatedDatabase(async () => {
    queueChatMessage({ id: 'o1', sessionId: 'chat-16', userId: '1', content: 'ход умер нештатно', options: {} });
    const claimed = chatMessageQueueDb.claimFirst('chat-16');
    assert.ok(claimed);

    // Живого хода нет — захват осиротел: сторож (ORPHAN_CLAIM_MS в обходе)
    // снимает его, и строка снова доступна отправке.
    const released = chatMessageQueueDb.releaseStaleClaims('chat-16', 0);
    assert.equal(released, 1);
    assert.deepEqual(chatMessageQueueDb.sessionsWithQueue(), ['chat-16']);
  });
});

test('«Сейчас» на отказавшей строке: ошибка снимается, строка снова обычная', async () => {
  await withIsolatedDatabase(() => {
    queueChatMessage({ id: 'r1', sessionId: 'chat-17', userId: '1', content: 'попробую ещё', options: {} });
    const claimed = chatMessageQueueDb.claimFirst('chat-17');
    assert.ok(claimed);
    chatMessageQueueDb.markFailed(claimed.id, 'провайдер недоступен');

    // Человек нажал «Сейчас» — сервер делает markQueued и дальше обычный путь.
    chatMessageQueueDb.markQueued('r1');
    const [row] = chatMessageQueueDb.list('chat-17');
    assert.equal(row.state, 'queued');
    assert.equal(row.lastError, null);
    assert.equal(listChatQueue('chat-17')[0]?.error, undefined);
  });
});

test('прямая отправка встаёт в хвост захваченной: порядок очереди не ломается', async () => {
  await withIsolatedDatabase(() => {
    queueChatMessage({ id: 'w1', sessionId: 'chat-18', userId: '1', content: 'ждёт первым', options: {} });
    chatMessageQueueDb.appendClaimedLast({
      id: 'direct1', sessionId: 'chat-18', userId: '1', content: 'прямое сейчас', options: {},
    });

    // Прямое — захвачено и в хвосте: его возврат не обгонит стоявшее раньше.
    const claimed = chatMessageQueueDb.claimFirst('chat-18');
    assert.equal(claimed?.id, 'w1');
  });
});
