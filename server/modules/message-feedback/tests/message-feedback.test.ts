import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  FeedbackValidationError,
  listSessionFeedback,
  saveMessageFeedback,
} from '@/modules/message-feedback/message-feedback.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'message-feedback-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const userId = (username: string): number => Number(
  getConnection().prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')").run(username).lastInsertRowid,
);

test('одна оценка на сообщение: повторный PUT обновляет строку, а не плодит дубли', async () => {
  await withIsolatedDatabase(() => {
    const uid = userId('egor');
    const first = saveMessageFeedback({
      messageId: 'msg-1',
      sessionId: 'sess-1',
      userId: uid,
      direction: 'dislike',
      category: 'too_long',
      comment: 'раздуто',
      domain: 'code',
      formatHash: 'hash-1',
    });
    assert.equal(first.direction, -1);
    assert.equal(first.revision, 1);

    const second = saveMessageFeedback({
      messageId: 'msg-1',
      sessionId: 'sess-1',
      userId: uid,
      direction: 'like',
    });
    assert.equal(second.direction, 1);
    assert.equal(second.revision, 2);
    // domain/format_hash — слепок формы сообщения, смена голоса их не стирает.
    assert.equal(second.domain, 'code');
    assert.equal(second.formatHash, 'hash-1');

    const count = getConnection()
      .prepare('SELECT COUNT(*) AS c FROM message_feedback WHERE message_id = ?')
      .get('msg-1') as { c: number };
    assert.equal(count.c, 1);
  });
});

test('оценки сессии читаются только владельцем', async () => {
  await withIsolatedDatabase(() => {
    const egor = userId('egor');
    const other = userId('other');
    saveMessageFeedback({
      messageId: 'msg-9',
      sessionId: 'sess-9',
      userId: egor,
      direction: 'dislike',
      category: 'unclear',
    });
    assert.equal(listSessionFeedback('sess-9', egor).length, 1);
    assert.equal(listSessionFeedback('sess-9', other).length, 0);
  });
});

test('валидация: неизвестная категория, дизлайк без причины, комментарий длиннее 2000', async () => {
  await withIsolatedDatabase(() => {
    const uid = userId('egor');
    const base = { messageId: 'm', sessionId: 's', userId: uid };
    assert.throws(
      () => saveMessageFeedback({ ...base, direction: 'dislike', category: 'bogus' }),
      FeedbackValidationError
    );
    assert.throws(
      () => saveMessageFeedback({ ...base, direction: 'dislike' }),
      FeedbackValidationError
    );
    assert.throws(
      () =>
        saveMessageFeedback({
          ...base,
          direction: 'dislike',
          category: 'custom',
          comment: 'ы'.repeat(2001),
        }),
      FeedbackValidationError
    );
    const ok = saveMessageFeedback({
      ...base,
      direction: 'dislike',
      category: 'custom',
      comment: 'ы'.repeat(2000),
    });
    assert.equal(ok.direction, -1);
  });
});
