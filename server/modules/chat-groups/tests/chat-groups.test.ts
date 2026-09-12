import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { chatGroupsDb, matchGroupForText } from '@/modules/database/repositories/chat-groups.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

const ACCOUNT = '/accounts/egor';
const OTHER = '/accounts/guest';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-groups-'));
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

function addSession(id: string, title: string, account = ACCOUNT, projectPath = '/home/egor') {
  sessionsDb.createSession(id, 'claude', projectPath, title);
  getConnection().prepare('UPDATE sessions SET account_dir = ? WHERE session_id = ?').run(account, id);
}

function groupOf(id: string) {
  return getConnection()
    .prepare('SELECT group_id, group_label, group_source FROM sessions WHERE session_id = ?')
    .get(id) as { group_id: string | null; group_label: string | null; group_source: string | null };
}

test('слова подбирают группу без учёта регистра, старшая группа выигрывает', () => {
  const groups = [
    { id: 'a', name: 'SunSchool', keywords: ['sunschool', 'бриф'] },
    { id: 'b', name: 'Боты', keywords: ['бриф', 'бот'] },
  ];
  assert.equal(matchGroupForText('Бриф 45 — руки-подсказки', groups)?.id, 'a');
  assert.equal(matchGroupForText('Бот не отвечает', groups)?.id, 'b');
  assert.equal(matchGroupForText('SSH между серверами', groups), null);
});

test('слово ищется с начала слова: «бот» не прячется внутри «Работа»', () => {
  const groups = [{ id: 'b', name: 'Боты', keywords: ['бот', 'bot'] }];
  assert.equal(matchGroupForText('Работа c Thoughts', groups), null);
  assert.equal(matchGroupForText('MaClaudeServerBot доступ', groups), null);
  assert.equal(matchGroupForText('Ботов стало больше', groups)?.id, 'b');
  assert.equal(matchGroupForText('чат /home/claude/sozidateli-bot', groups)?.id, 'b');
});

test('автоматика раскладывает чаты, ручной выбор она не трогает', async () => {
  await withIsolatedDatabase(() => {
    const school = chatGroupsDb.create(ACCOUNT, { name: 'SunSchool', keywords: ['SunSchool', 'бриф'] });
    addSession('s1', 'Бриф 47 экран задание');
    addSession('s2', 'Карта денег на доске');
    addSession('s3', 'Sunschool tablet build');
    addSession('s4', 'Что угодно', ACCOUNT, '/home/claude/sunschool');

    chatGroupsDb.assignManually(ACCOUNT, 's3', null);
    const changed = chatGroupsDb.autoAssignAll(ACCOUNT);

    assert.deepEqual(changed.sort(), ['s1', 's4']);
    assert.equal(groupOf('s1').group_id, school.id);
    assert.equal(groupOf('s1').group_label, 'SunSchool');
    assert.equal(groupOf('s1').group_source, 'auto');
    assert.equal(groupOf('s2').group_id, null);
    assert.equal(groupOf('s3').group_id, null, 'человек вынул чат из группы — автоматика не возвращает');
    assert.equal(groupOf('s4').group_id, school.id, 'путь проекта тоже учитывается');
  });
});

test('смена названия пересматривает автоматическую группу', async () => {
  await withIsolatedDatabase(() => {
    chatGroupsDb.create(ACCOUNT, { name: 'SunSchool', keywords: ['sunschool'] });
    const bots = chatGroupsDb.create(ACCOUNT, { name: 'Боты', keywords: ['бот'] });
    addSession('s1', 'SunSchool заставка');
    chatGroupsDb.autoAssignSession('s1');

    sessionsDb.renameSessionByUser('s1', 'Бот мыслей');
    assert.equal(chatGroupsDb.autoAssignSession('s1'), true);
    assert.equal(groupOf('s1').group_id, bots.id);
  });
});

test('чужой аккаунт не видит и не может назначить чужую группу', async () => {
  await withIsolatedDatabase(() => {
    const mine = chatGroupsDb.create(ACCOUNT, { name: 'SunSchool', keywords: ['sunschool'] });
    addSession('guest-chat', 'sunschool у гостя', OTHER);

    assert.equal(chatGroupsDb.list(OTHER).length, 0);
    assert.equal(chatGroupsDb.assignManually(OTHER, 'guest-chat', mine.id), false);
    chatGroupsDb.autoAssignSession('guest-chat');
    assert.equal(groupOf('guest-chat').group_id, null, 'слова чужой группы не применяются к гостю');
  });
});

test('свежая группа наверху, архивные чаты не считаются', async () => {
  await withIsolatedDatabase(() => {
    const old = chatGroupsDb.create(ACCOUNT, { name: 'Старая', keywords: ['старое'] });
    const fresh = chatGroupsDb.create(ACCOUNT, { name: 'Свежая', keywords: ['свежее'] });
    addSession('a', 'старое дело');
    addSession('b', 'свежее дело');
    addSession('c', 'свежее в архиве');
    const db = getConnection();
    db.prepare("UPDATE sessions SET updated_at = '2026-01-01T10:00:00Z' WHERE session_id = 'a'").run();
    db.prepare("UPDATE sessions SET updated_at = '2026-09-01T10:00:00Z' WHERE session_id = 'b'").run();
    chatGroupsDb.autoAssignAll(ACCOUNT);
    sessionsDb.updateSessionIsArchived('c', true);

    const list = chatGroupsDb.list(ACCOUNT);
    assert.deepEqual(list.map((g) => g.id), [fresh.id, old.id]);
    assert.equal(list[0].sessionCount, 1);
  });
});

test('имя группы уникально и переименование доезжает до чатов', async () => {
  await withIsolatedDatabase(() => {
    const group = chatGroupsDb.create(ACCOUNT, { name: 'Сайт', keywords: ['claude ui'] });
    assert.throws(() => chatGroupsDb.create(ACCOUNT, { name: 'Сайт' }));
    addSession('s1', 'Claude UI вкладки');
    chatGroupsDb.autoAssignAll(ACCOUNT);
    chatGroupsDb.update(ACCOUNT, group.id, { name: 'Сайт Claude' });
    assert.equal(groupOf('s1').group_label, 'Сайт Claude');
  });
});
