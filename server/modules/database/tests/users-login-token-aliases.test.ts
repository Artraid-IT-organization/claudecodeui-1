import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'users-aliases-'));
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

test('алиас пускает человека наравне с основным токеном', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUserWithLoginToken('igor', 'hash', 'new-token');
    userDb.addLoginTokenAlias(Number(user.id), 'old-room-token', 'комната igor');

    assert.equal(userDb.getUserByLoginToken('new-token')?.username, 'igor');
    assert.equal(userDb.getUserByLoginToken('old-room-token')?.username, 'igor');
    assert.equal(userDb.getUserByLoginToken('чужой'), undefined);
  });
});

test('чужой алиас не пускает: токен привязан к своему пользователю', async () => {
  await withIsolatedDatabase(() => {
    const a = userDb.createUserWithLoginToken('anna', 'hash', 'anna-token');
    userDb.createUserWithLoginToken('olga', 'hash', 'olga-token');
    userDb.addLoginTokenAlias(Number(a.id), 'anna-old', undefined);

    assert.equal(userDb.getUserByLoginToken('anna-old')?.username, 'anna');
    assert.equal(userDb.getUserByLoginToken('olga-token')?.username, 'olga');
  });
});

test('перевыпуск ссылки гасит и алиасы — отзыв не мнимый', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUserWithLoginToken('vince', 'hash', 'vince-token');
    userDb.addLoginTokenAlias(Number(user.id), 'vince-room', undefined);

    userDb.setLoginToken(Number(user.id), 'vince-fresh');

    assert.equal(userDb.getUserByLoginToken('vince-token'), undefined);
    assert.equal(userDb.getUserByLoginToken('vince-room'), undefined);
    assert.equal(userDb.getUserByLoginToken('vince-fresh')?.username, 'vince');
  });
});

test('addLoginTokenAlias идемпотентен по токену', async () => {
  await withIsolatedDatabase(() => {
    const user = userDb.createUserWithLoginToken('ta', 'hash', 'ta-token');
    userDb.addLoginTokenAlias(Number(user.id), 'ta-old', 'first');
    userDb.addLoginTokenAlias(Number(user.id), 'ta-old', 'second');

    assert.equal(userDb.getUserByLoginToken('ta-old')?.username, 'ta');
  });
});
