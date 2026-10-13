import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * IDOR-регрессия (аудит 10.10.26): проверка владельца сессии стояла только на
 * devin-строках, и чужой claude-чат читался, переименовывался и удалялся по
 * прямой ссылке. Этот файл гоняется в собственном процессе node:test, поэтому
 * env ставится ДО динамического импорта модулей — `OPEN_REGISTRATION` и
 * `PLATFORM_OWNER_WEB_USER_IDS` читаются один раз при загрузке shared/utils.
 */
process.env.OPEN_REGISTRATION = 'true';
process.env.PLATFORM_OWNER_WEB_USER_IDS = '1';

const dbDir = await mkdtemp(path.join(os.tmpdir(), 'session-ownership-db-'));
process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');

const { initializeDatabase, closeConnection, sessionsDb } = await import('@/modules/database/index.js');
const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');
const { runWithRequestRuntimeContext } = await import('@/shared/request-context.js');

await initializeDatabase();

const GUEST_HOME = path.join(dbDir, 'guest-107');
const VICTIM_HOME = path.join(dbDir, 'victim-105');

function asGuest<T>(fn: () => T): T {
  return runWithRequestRuntimeContext(
    { userId: 107, claudeConfigDir: GUEST_HOME, workspaceRoot: path.join(dbDir, 'ws-107') },
    fn,
  );
}

function asOwner<T>(fn: () => T): T {
  return runWithRequestRuntimeContext(
    { userId: 1, claudeConfigDir: VICTIM_HOME, workspaceRoot: path.join(dbDir, 'ws-1') },
    fn,
  );
}

test.after(async () => {
  closeConnection();
  await rm(dbDir, { recursive: true, force: true });
});

test('гость не может переименовать чужой claude-чат (IDOR на не-devin провайдере)', async () => {
  sessionsDb.createSession('victim-claude', 'claude', '/ws/work', 'Victim', undefined, undefined, null, undefined, {
    accountDir: VICTIM_HOME,
    origin: 'web',
  });

  assert.throws(
    () => asGuest(() => sessionsService.renameSessionById('victim-claude', 'hacked')),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'PROVIDER_NOT_ALLOWED',
  );
  assert.equal(sessionsDb.getSessionById('victim-claude')?.custom_name, 'Victim');
});

test('гость не может удалить и не может прочитать метаданные чужого claude-чата', async () => {
  sessionsDb.createSession('victim-claude-2', 'claude', '/ws/work', 'Victim2', undefined, undefined, null, undefined, {
    accountDir: VICTIM_HOME,
    origin: 'web',
  });

  assert.throws(
    () => asGuest(() => sessionsService.getSessionDetailsById('victim-claude-2')),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'PROVIDER_NOT_ALLOWED',
  );
  await assert.rejects(
    () => asGuest(() => sessionsService.deleteOrArchiveSessionById('victim-claude-2', { force: false })),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'PROVIDER_NOT_ALLOWED',
  );
  assert.equal(sessionsDb.getSessionById('victim-claude-2')?.isArchived, 0);
});

test('свой claude-чат (account_dir совпал) гость меняет свободно', () => {
  sessionsDb.createSession('mine-claude', 'claude', '/ws/work', 'Mine', undefined, undefined, null, undefined, {
    accountDir: GUEST_HOME,
    origin: 'web',
  });

  assert.doesNotThrow(() => asGuest(() => sessionsService.renameSessionById('mine-claude', 'Mine renamed')));
  assert.equal(sessionsDb.getSessionById('mine-claude')?.custom_name, 'Mine renamed');
});

test('чат, начатый гостем (initiated_by_user_id), доступен ему по атрибуции app-строки', () => {
  // createAppSession читает request-контекст: initiated_by_user_id=107,
  // account_dir — каталог из контекста гостя.
  asGuest(() => sessionsDb.createAppSession('app-initiated', 'claude', '/ws/work', 'AppInit'));
  const row = sessionsDb.getSessionById('app-initiated');
  assert.equal(row?.initiated_by_user_id, 107);
  assert.equal(row?.account_dir, GUEST_HOME);

  assert.doesNotThrow(() => asGuest(() => sessionsService.renameSessionById('app-initiated', 'My own app chat')));
});

test('владелец площадки (PLATFORM_OWNER_WEB_USER_IDS) может чужой чат', () => {
  assert.doesNotThrow(() => asOwner(() => sessionsService.renameSessionById('victim-claude', 'owner renamed')));
  assert.equal(sessionsDb.getSessionById('victim-claude')?.custom_name, 'owner renamed');
});

test('наследная строка без владельца (NULL account_dir, NULL initiated_by) гостю закрыта', () => {
  sessionsDb.createSession('legacy-null', 'claude', '/ws/work', 'Legacy', undefined, undefined, null, undefined, {
    accountDir: null,
    origin: 'terminal',
  });

  assert.throws(
    () => asGuest(() => sessionsService.renameSessionById('legacy-null', 'hacked')),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'PROVIDER_NOT_ALLOWED',
  );
});
