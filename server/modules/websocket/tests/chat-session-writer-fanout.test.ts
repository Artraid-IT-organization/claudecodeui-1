import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';

const OPEN = 1;
const CLOSED = 3;

function fakeSocket() {
  const sent: string[] = [];
  return { readyState: OPEN, sent, send(data: string) { sent.push(data); } };
}

function makeWriter(connection: ReturnType<typeof fakeSocket>) {
  return new ChatSessionWriter({
    connection,
    userId: 1,
    provider: 'claude',
    providerSessionId: null,
    onProviderSessionId: () => {},
    decorateOutboundEvent: (message: unknown) => message,
  } as any);
}

test('новая подписка не вытесняет прежнюю вкладку: события уходят в обе', () => {
  const phone = fakeSocket();
  const desktop = fakeSocket();
  const writer = makeWriter(phone);

  writer.updateWebSocket(desktop);
  writer.send({ kind: 'thinking_delta', content: '', sessionId: 's', provider: 'claude' });

  assert.equal(phone.sent.length, 1, 'телефон продолжает получать события');
  assert.equal(desktop.sent.length, 1, 'компьютер тоже получает');
});

test('закрытая вкладка перестаёт получать события, живая получает', () => {
  const closed = fakeSocket();
  const live = fakeSocket();
  const writer = makeWriter(closed);
  writer.updateWebSocket(live);

  closed.readyState = CLOSED;
  writer.send({ kind: 'stream_delta', content: 'a', sessionId: 's', provider: 'claude' });
  writer.send({ kind: 'stream_delta', content: 'b', sessionId: 's', provider: 'claude' });

  assert.equal(closed.sent.length, 0);
  assert.equal(live.sent.length, 2);
});

test('повторная подписка той же вкладки не дублирует события', () => {
  const tab = fakeSocket();
  const writer = makeWriter(tab);
  writer.updateWebSocket(tab);
  writer.updateWebSocket(tab);
  writer.send({ kind: 'stream_delta', content: 'x', sessionId: 's', provider: 'claude' });
  assert.equal(tab.sent.length, 1);
});
