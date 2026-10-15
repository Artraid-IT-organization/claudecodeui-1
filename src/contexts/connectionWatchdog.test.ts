import assert from 'node:assert/strict';
import test from 'node:test';

import { decideConnectionAction, isConnectionStableFrame, SOCKET_STATE } from './connectionWatchdog';

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

test('рукопожатие и служебные кадры не подтверждают устойчивость соединения', () => {
  assert.equal(isConnectionStableFrame('server_capabilities', 25_000), false);
  assert.equal(isConnectionStableFrame('chat_subscribed', 25_000), false);
  assert.equal(isConnectionStableFrame('server_ping', null), false);
});

test('плановый heartbeat подтверждает устойчивость соединения', () => {
  assert.equal(isConnectionStableFrame('server_ping', 25_000), true);
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

test('открытый сокет без прикладных пингов сервера — молчание не считаем', () => {
  // Старый сервер пингов не шлёт: долгое молчание — норма, а не сбой.
  assert.equal(
    decideConnectionAction(snapshot({ silentForMs: 600_000, silenceLimitMs: Infinity })),
    'ok',
  );
});

test('открытый сокет молчит дольше нормы — сначала проба, не пересоздание', () => {
  assert.equal(
    decideConnectionAction(snapshot({ silentForMs: 80_000, silenceLimitMs: 75_000 })),
    'probe',
  );
});

test('проба в полёте и срок не вышел — ждём ответ', () => {
  assert.equal(
    decideConnectionAction(
      snapshot({ silentForMs: 90_000, silenceLimitMs: 75_000, probeAgeMs: 1_000 }),
    ),
    'wait',
  );
});

test('проба осталась без ответа — сокет пересоздаём', () => {
  assert.equal(
    decideConnectionAction(
      snapshot({ silentForMs: 90_000, silenceLimitMs: 75_000, probeAgeMs: 5_000 }),
    ),
    'recreate',
  );
});

test('после ответа на пробу молчание кончилось — сокет жив', () => {
  assert.equal(
    decideConnectionAction(snapshot({ silentForMs: 1_000, silenceLimitMs: 75_000 })),
    'ok',
  );
});
