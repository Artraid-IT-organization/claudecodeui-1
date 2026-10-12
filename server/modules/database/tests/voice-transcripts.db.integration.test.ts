import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { voiceTranscriptsDb } from '@/modules/database/repositories/voice-transcripts.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'voice-transcripts-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('receipt, transcript and delivery close the inbox lifecycle', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(voiceTranscriptsDb.get('rec-1', 7), null);

    voiceTranscriptsDb.upsertReceived(
      { recId: 'rec-1', sessionId: 'sess-1', scope: 'sess-1', send: false },
      7,
    );
    const received = voiceTranscriptsDb.get('rec-1', 7);
    assert.equal(received?.sessionId, 'sess-1');
    assert.equal(received?.text, null);
    // Без текста в инбоксе делать нечего.
    assert.deepEqual(voiceTranscriptsDb.listUndelivered(7), []);

    voiceTranscriptsDb.setText('rec-1', 7, 'привет мир');
    const pending = voiceTranscriptsDb.listUndelivered(7);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].text, 'привет мир');

    voiceTranscriptsDb.markDelivered('rec-1', 7);
    assert.deepEqual(voiceTranscriptsDb.listUndelivered(7), []);
  });
});

test('dedupe returns the stored transcript and send flag only rises', async () => {
  await withIsolatedDatabase(() => {
    voiceTranscriptsDb.upsertReceived(
      { recId: 'rec-2', sessionId: 'sess-9', scope: 'sess-9', send: false },
      0,
    );
    voiceTranscriptsDb.setText('rec-2', 0, 'готовый текст');
    // Повтор той же записи: текст и адресат остаются от первого приёма.
    voiceTranscriptsDb.upsertReceived(
      { recId: 'rec-2', sessionId: null, scope: null, send: false },
      0,
    );
    const row = voiceTranscriptsDb.get('rec-2', 0);
    assert.equal(row?.text, 'готовый текст');
    assert.equal(row?.sessionId, 'sess-9');
    // А поздний флаг «отправить» — поднимается, не сбрасывается.
    voiceTranscriptsDb.upsertReceived(
      { recId: 'rec-2', sessionId: 'sess-9', scope: 'sess-9', send: true },
      0,
    );
    assert.equal(voiceTranscriptsDb.get('rec-2', 0)?.send, true);
  });
});

test('rows without a delivery target stay out of the pending inbox', async () => {
  await withIsolatedDatabase(() => {
    voiceTranscriptsDb.upsertReceived({ recId: 'rec-3', sessionId: null, scope: null, send: false }, 5);
    voiceTranscriptsDb.setText('rec-3', 5, 'без адресата');
    assert.deepEqual(voiceTranscriptsDb.listUndelivered(5), []);
    // Дедуп при этом работает: повторная загрузка отдаст тот же текст.
    assert.equal(voiceTranscriptsDb.get('rec-3', 5)?.text, 'без адресата');
  });
});
