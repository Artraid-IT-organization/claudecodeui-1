import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-migration-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

/**
 * Одна строка стенограммы Claude в формате jsonl: читалка фильтрует по
 * `sessionId` и берёт текст из `message.content[].text`.
 */
const claudeTranscriptLine = (
  claudeSessionId: string,
  role: 'user' | 'assistant',
  text: string,
  cwd: string,
): string =>
  JSON.stringify({
    type: role,
    sessionId: claudeSessionId,
    cwd,
    timestamp: '2026-10-01T10:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  });

test('retargetSessionProvider переводит чат на другого провайдера и забывает его provider id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('migrated-1', 'claude', '/tmp/provider-migration-project');
    sessionsDb.assignProviderSessionId('migrated-1', 'claude-native-id');
    sessionsDb.setJsonlPathIfMissing('migrated-1', '/tmp/legacy-transcript.jsonl');

    sessionsDb.retargetSessionProvider('migrated-1', 'devin');

    const row = sessionsDb.getSessionById('migrated-1');
    assert.equal(row?.provider, 'devin');
    // Новый провайдер начнёт свою сессию — чужой id ему не продолжить.
    assert.equal(row?.provider_session_id, null);
    // Файл старой переписки остаётся: читалка истории доклеивает его к ленте.
    assert.equal(row?.jsonl_path, '/tmp/legacy-transcript.jsonl');
  });
});

test('синхронизатор Claude не садит призрачную строку по стенограмме переведённого чата', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-migration-sync-'));
  const claudeConfigDir = path.join(tempRoot, '.claude');
  const transcriptsDir = path.join(claudeConfigDir, 'projects', '-tmp-project');
  await mkdir(transcriptsDir, { recursive: true });

  const claudeSessionId = 'cccccccc-1111-4222-8333-444444444444';
  const transcriptPath = path.join(transcriptsDir, `${claudeSessionId}.jsonl`);
  await writeFile(
    transcriptPath,
    `${claudeTranscriptLine(claudeSessionId, 'user', 'старое сообщение', '/tmp/project')}\n`,
    'utf8',
  );

  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

  try {
    await withIsolatedDatabase(() => {
      // Строка чата уже переведена на Devin, файл переписки остался у неё.
      sessionsDb.createAppSession('migrated-2', 'claude', '/tmp/project');
      sessionsDb.retargetSessionProvider('migrated-2', 'devin');
      sessionsDb.setJsonlPathIfMissing('migrated-2', transcriptPath);

      return new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath).then((indexed) => {
        assert.equal(indexed, null);
        // Призрачной строки под провайдером 'claude' по той же стенограмме нет.
        assert.equal(sessionsDb.getSessionById(claudeSessionId), null);
        assert.equal(sessionsDb.getSessionByTranscriptPath(transcriptPath)?.session_id, 'migrated-2');
      });
    });
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('история переведённого чата начинается перепиской из старой стенограммы', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-migration-history-'));
  const claudeSessionId = 'dddddddd-1111-4222-8333-555555555555';
  const transcriptPath = path.join(tempRoot, `${claudeSessionId}.jsonl`);
  await writeFile(
    transcriptPath,
    [
      claudeTranscriptLine(claudeSessionId, 'user', 'старое сообщение', '/tmp/project'),
      claudeTranscriptLine(claudeSessionId, 'assistant', 'старый ответ', '/tmp/project'),
    ].join('\n') + '\n',
    'utf8',
  );

  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('migrated-3', 'claude', '/tmp/project');
      sessionsDb.setJsonlPathIfMissing('migrated-3', transcriptPath);
      sessionsDb.retargetSessionProvider('migrated-3', 'devin');

      const history = await sessionsService.fetchHistory('migrated-3');
      const texts = history.messages.map((message) => JSON.stringify(message));
      assert.ok(
        texts.some((text) => text.includes('старое сообщение')),
        'старая переписка должна читаться из оставшегося jsonl',
      );
      assert.ok(
        texts.some((text) => text.includes('старый ответ')),
        'старый ответ тоже в ленте',
      );
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
