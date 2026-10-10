import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { getActiveAccountDir } from '@/shared/session-scope.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
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

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

/**
 * Повторная запись сессии обновляет её, но НЕ возвращает из архива.
 *
 * Раньше возвращала, и это ломало главное, о чём просил владелец: убрать из
 * списка чатов запуски ботов и скриптов. Их там были сотни, они убирались в
 * архив — и тут же возвращались обратно, потому что пересборка истории
 * перезаписывает каждую строку, а перезапись считалась признаком «сессия
 * снова живая». Признак оказался ложным: заново читая файл с диска, мы узнаём
 * содержимое, а не намерение человека.
 *
 * Разархивировать теперь можно только руками — это и есть решение человека.
 */
test('createSession updates an archived row without pulling it back into the list', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const reusedSession = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 0);
    assert.equal(archivedSessions.length, 1);
    assert.equal(archivedSessions[0]?.session_id, 'session-reused');
    assert.equal(reusedSession?.custom_name, 'Updated Name');
    assert.equal(reusedSession?.isArchived, 1);

    // Вернуть в список можно — но только явным действием.
    sessionsDb.updateSessionIsArchived('session-reused', false);
    assert.equal(sessionsDb.getAllSessions().length, 1);
  });
});

test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('recent sessions are globally ordered, paginated, and limited to visible conversations', async () => {
  await withIsolatedDatabase(() => {
    const fixtures: Array<Parameters<typeof sessionsDb.createSession>> = [
      ['session-oldest', 'claude', '/workspace/project-a', 'Oldest', '2026-07-18T09:00:00.000Z', '2026-07-18T10:00:00.000Z'],
      ['session-newest', 'codex', '/workspace/project-b', 'Newest', '2026-07-18T11:00:00.000Z', '2026-07-18T12:00:00.900Z'],
      ['session-same-second', 'claude', '/workspace/project-a', 'Same second, slightly older', '2026-07-18T12:00:00.000Z', '2026-07-18T12:00:00.100Z'],
      ['session-middle', 'claude', '/workspace/project-a', 'Middle', '2026-07-18T10:00:00.000Z', '2026-07-18T11:00:00.000Z'],
      ['session-archived', 'claude', '/workspace/project-a', 'Archived session', '2026-07-18T13:00:00.000Z', '2026-07-18T13:00:00.000Z'],
      ['session-hidden-project', 'claude', '/workspace/project-hidden', 'Archived project session', '2026-07-18T14:00:00.000Z', '2026-07-18T14:00:00.000Z'],
    ];
    fixtures.forEach((fixture) => sessionsDb.createSession(...fixture));

    sessionsDb.updateSessionIsArchived('session-archived', true);
    projectsDb.updateProjectIsArchived('/workspace/project-hidden', true);

    const firstPage = sessionsDb.getRecentSessionsPage(2, 0);
    const secondPage = sessionsDb.getRecentSessionsPage(2, 2);

    assert.equal(firstPage.total, 4);
    assert.deepEqual(
      firstPage.sessions.map((session) => session.session_id),
      ['session-newest', 'session-same-second'],
    );
    assert.equal(secondPage.total, 4);
    assert.deepEqual(
      secondPage.sessions.map((session) => session.session_id),
      ['session-middle', 'session-oldest'],
    );
  });
});

/**
 * project_path app-строки (origin='web') синхронизатор не перетирает.
 *
 * Devin записывает в свою sessions.db `working_directory` в realpath-
 * написании, а чат, созданный из веба, хранит лексический путь, который
 * выбрал человек (у гостей team-access `workspace/work` — симлинк). До
 * исправления следующий проход синхронизатора переписывал project_path
 * realpath'ом — и чат уезжал в одноимённый проект-двойник («не все чаты в
 * списке», аудит 10.10.26). Строкам без веб-выбора (terminal/auto) cwd
 * провайдера по-прежнему правда: чат мог физически переехать.
 */
test('createSession keeps the web-chosen project_path on provider upserts', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-bound', 'devin', '/home/guest/workspace/work', 'Веб-чат');
    sessionsDb.assignProviderSessionId('app-bound', 'provider-xyz');

    sessionsDb.createSession('provider-xyz', 'devin', '/home/guest/team-access/home/work', 'Веб-чат');

    const row = sessionsDb.getSessionById('app-bound');
    assert.equal(row?.provider_session_id, 'provider-xyz');
    assert.equal(row?.project_path, '/home/guest/workspace/work');
    assert.equal(sessionsDb.getSessionByProviderSessionId('provider-xyz')?.session_id, 'app-bound');
  });
});

test('createSession still applies provider cwd for non-web rows', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'cli-chat', 'claude', '/old/place', 'CLI chat',
      undefined, undefined, null, undefined,
      { accountDir: null, origin: 'terminal' },
    );

    sessionsDb.createSession(
      'cli-chat', 'claude', '/new/place', 'CLI chat',
      undefined, undefined, null, undefined,
      { accountDir: null, origin: 'terminal' },
    );

    assert.equal(sessionsDb.getSessionById('cli-chat')?.project_path, '/new/place');
  });
});

/**
 * Архивный вид проекта — тоже скоуплен по аккаунту: один и тот же
 * project_path у разных webuser-корней (симлинк/realpath даёт одинаковое
 * написание) не должен показывать чужие сессии даже в архиве.
 */
test('getSessionsByProjectPathIncludingArchived filters other accounts rows', async () => {
  await withIsolatedDatabase(() => {
    const myDir = getActiveAccountDir();
    sessionsDb.createSession('mine-archived', 'claude', '/shared/path', 'Mine', undefined, undefined, null, undefined, {
      accountDir: myDir,
      origin: 'web',
    });
    sessionsDb.createSession('foreign-archived', 'claude', '/shared/path', 'Foreign', undefined, undefined, null, undefined, {
      accountDir: '/home/other/.claude-webuser-999',
      origin: 'web',
    });
    sessionsDb.createSession('legacy-null-dir', 'claude', '/shared/path', 'Legacy', undefined, undefined, null, undefined, {
      accountDir: null,
      origin: 'terminal',
    });
    for (const id of ['mine-archived', 'foreign-archived', 'legacy-null-dir']) {
      sessionsDb.updateSessionIsArchived(id, true);
    }

    const rows = sessionsDb.getSessionsByProjectPathIncludingArchived('/shared/path');
    assert.deepEqual(
      rows.map((session) => session.session_id).sort(),
      ['legacy-null-dir', 'mine-archived'],
    );
  });
});
