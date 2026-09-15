import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-ledger-'));
process.env.CLOUDCLI_SEND_LEDGER_PATH = path.join(dir, 'ledger.json');

const {
  hasAcceptedSend,
  readClientMessageId,
  rememberAcceptedSend,
  resetSendLedgerForTests,
} = await import('@/modules/websocket/services/chat-send-ledger.service.js');

test('принятое сообщение узнаётся и после перезапуска сервера', () => {
  assert.equal(hasAcceptedSend('chat-1', 'msg-00000001'), false);
  rememberAcceptedSend('chat-1', 'msg-00000001');
  assert.equal(hasAcceptedSend('chat-1', 'msg-00000001'), true);

  resetSendLedgerForTests(); // как новый процесс сервера
  assert.equal(hasAcceptedSend('chat-1', 'msg-00000001'), true);
  assert.equal(hasAcceptedSend('chat-2', 'msg-00000001'), false, 'номер привязан к чату');
});

test('номер сообщения принимается только похожий на номер', () => {
  assert.equal(readClientMessageId({ clientMessageId: '6f1c2d3e-aaaa-bbbb-cccc-1234567890ab' }), '6f1c2d3e-aaaa-bbbb-cccc-1234567890ab');
  assert.equal(readClientMessageId({}), null);
  assert.equal(readClientMessageId({ clientMessageId: 'short' }), null);
  assert.equal(readClientMessageId({ clientMessageId: '../../etc/passwd' }), null);
  assert.equal(readClientMessageId({ clientMessageId: 42 }), null);
});
