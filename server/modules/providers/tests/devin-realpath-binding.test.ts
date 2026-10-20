import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { DevinSessionSynchronizer } from '@/modules/providers/list/devin/devin-session-synchronizer.provider.js';

/**
 * Привязка app-строки к devin-сессии по realpath (аудит 10.10.26).
 *
 * Devin записывает в свою sessions.db `working_directory` в realpath-
 * написании, а app-строка рождается с лексическим путём, который человек
 * выбрал в интерфейсе — у гостей team-access `workspace/work` это симлинк.
 * Точное совпадение строк их не связывало: чат получал вторую строку с
 * realpath-проектом и уезжал в одноимённый проект-двойник.
 */
async function withDevinFixture(
  runTest: (dirs: { xdgHome: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const dbDir = await mkdtemp(path.join(os.tmpdir(), 'devin-binding-db-'));
  const xdgHome = await mkdtemp(path.join(os.tmpdir(), 'devin-binding-xdg-'));
  const claudeDir = await mkdtemp(path.join(os.tmpdir(), 'devin-binding-claude-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
  process.env.XDG_DATA_HOME = xdgHome;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  await initializeDatabase();

  try {
    await runTest({ xdgHome });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    await rm(dbDir, { recursive: true, force: true });
    await rm(xdgHome, { recursive: true, force: true });
    await rm(claudeDir, { recursive: true, force: true });
  }
}

function writeDevinSessionsDb(xdgHome: string, rows: Array<{ id: string; working_directory: string }>): void {
  const cliDir = path.join(xdgHome, 'devin', 'cli');
  fsSync.mkdirSync(cliDir, { recursive: true });
  const db = new Database(path.join(cliDir, 'sessions.db'));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    working_directory TEXT,
    title TEXT,
    created_at INTEGER,
    last_activity_at INTEGER,
    hidden INTEGER DEFAULT 0
  )`);
  const insert = db.prepare(
    `INSERT INTO sessions (id, working_directory, title, created_at, last_activity_at, hidden)
     VALUES (?, ?, ?, ?, ?, 0)`,
  );
  for (const row of rows) {
    insert.run(row.id, row.working_directory, 'Devin chat', 1700000000, 1700000100);
  }
  db.close();
}

test(
  'realpath working_directory привязывается к app-строке с лексическим путём через симлинк',
  { concurrency: false },
  async () => {
    await withDevinFixture(async ({ xdgHome }) => {
      // Реальная папка и симлинк на неё — как `workspace/work` →
      // `team-access/people/vince/home/work` у гостей.
      const realWork = path.join(xdgHome, 'people', 'vince', 'home', 'work');
      await mkdir(realWork, { recursive: true });
      const linkDir = path.join(xdgHome, 'webuser-105', 'workspace');
      await mkdir(linkDir, { recursive: true });
      const lexicalWork = path.join(linkDir, 'work');
      await symlink(realWork, lexicalWork, 'dir');

      sessionsDb.createAppSession('app-chat', 'devin', lexicalWork, 'Чат из веба');
      writeDevinSessionsDb(xdgHome, [
        { id: 'provider-sid-1', working_directory: fsSync.realpathSync.native(lexicalWork) },
      ]);

      await new DevinSessionSynchronizer().synchronize();

      const bound = sessionsDb.getSessionById('app-chat');
      assert.equal(bound?.provider_session_id, 'provider-sid-1');
      // И проект остался тем, который выбрал человек, — не realpath-копией.
      assert.equal(bound?.project_path, lexicalWork);
      // Двойника под provider id не появилось.
      assert.equal(
        sessionsDb.getSessionByProviderSessionId('provider-sid-1')?.session_id,
        'app-chat',
      );
      assert.equal(sessionsDb.getSessionById('provider-sid-1'), null);
    });
  },
);
