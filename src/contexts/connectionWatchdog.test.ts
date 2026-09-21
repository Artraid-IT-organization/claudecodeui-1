import assert from 'node:assert/strict';
import test from 'node:test';

import { decideConnectionAction, SOCKET_STATE } from './connectionWatchdog';

const snapshot = (over: Partial<Parameters<typeof decideConnectionAction>[0]> = {}) => ({
  readyState: SOCKET_STATE.open as number | null,
  reconnectScheduled: false,
  connectingForMs: 0,
  stallMs: 15_000,
  ...over,
});

test('открытое соединение не трогаем', () => {
  assert.equal(decideConnectionAction(snapshot()), 'ok');
});

test('сокета нет — подключаемся', () => {
  assert.equal(decideConnectionAction(snapshot({ readyState: null })), 'connect');
});

test('сокета нет, но повтор уже назначен — ждём, второго соединения не плодим', () => {
  assert.equal(
    decideConnectionAction(snapshot({ readyState: null, reconnectScheduled: true })),
    'wait',
  );
});

test('рукопожатие идёт в пределах терпения — ждём', () => {
  assert.equal(
    decideConnectionAction(snapshot({ readyState: SOCKET_STATE.connecting, connectingForMs: 3_000 })),
    'wait',
  );
});

test('рукопожатие висит дольше терпения — пересоздаём', () => {
  assert.equal(
    decideConnectionAction(snapshot({ readyState: SOCKET_STATE.connecting, connectingForMs: 20_000 })),
    'recreate',
  );
});

test('закрытый сокет пересоздаём, даже если повтор назначен', () => {
  // Ровно этот случай оставлял телефон без связи: сервер закрыл сокет, а
  // назначенный на 3 секунды повтор замёрз вместе с фоновой вкладкой.
  for (const readyState of [SOCKET_STATE.closing, SOCKET_STATE.closed]) {
    assert.equal(decideConnectionAction(snapshot({ readyState })), 'recreate');
    assert.equal(
      decideConnectionAction(snapshot({ readyState, reconnectScheduled: true })),
      'recreate',
    );
  }
});
