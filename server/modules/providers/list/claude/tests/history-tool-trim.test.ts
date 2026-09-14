/**
 * Порция истории не таскает мегабайты вывода действий.
 *
 * Замер 15.09.26: одно чтение файла весило 1 МБ и ехало в порции дважды — в
 * вызове и в отдельном результате; 60 сообщений весили до 3,5 МБ, и телефон
 * подвисал, разбирая их при каждой подгрузке ранних сообщений. Длинные строки
 * внутри действий обрезаются, текст ответа — нет.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import { ClaudeSessionsProvider } from '../claude-sessions.provider.js';
import { forgetTranscriptTail } from '../transcript-tail-cache.js';

const SESSION_ID = 'trim-session-0001';
const PROJECT_PATH = '/workspace/trim-project';
const HUGE_FILE = 'б'.repeat(300_000);
const LONG_REPLY = 'в'.repeat(100_000);

function line(record: Record<string, unknown>, second: number): string {
  return `${JSON.stringify({
    sessionId: SESSION_ID,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    ...record,
  })}\n`;
}

test('история: длинный вывод действия обрезан, текст ответа целый', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'history-trim-'));
  const jsonlPath = path.join(directory, `${SESSION_ID}.jsonl`);

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  try {
    await writeFile(jsonlPath, [
      line({ type: 'user', message: { role: 'user', content: 'прочитай файл' } }, 1),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/big.txt' } }] },
      }, 2),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: HUGE_FILE }] },
        toolUseResult: { type: 'text', file: { filePath: '/big.txt', content: HUGE_FILE } },
      }, 3),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: LONG_REPLY }] } }, 4),
    ].join(''));
    sessionsDb.createSession(SESSION_ID, 'claude', PROJECT_PATH, undefined, undefined, undefined, jsonlPath);
    forgetTranscriptTail();

    const page = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
      limit: 60,
      offset: 0,
      providerSessionId: SESSION_ID,
      projectPath: PROJECT_PATH,
    });

    const body = JSON.stringify(page.messages);
    assert.ok(body.length < 400_000, `порция весит ${body.length} знаков — вывод действия не обрезан`);

    const toolUse = page.messages.find((message) => message.kind === 'tool_use');
    assert.ok(toolUse?.toolResult, 'результат чтения приложен к вызову');
    const shown = String((toolUse.toolResult as { content: string }).content);
    assert.ok(shown.length < 70_000, 'в вызове вывод обрезан');
    assert.match(shown, /в истории показаны первые 64 тыс\. знаков из 300 тыс\./);

    const reply = page.messages.find((message) => message.kind === 'text' && message.role === 'assistant');
    assert.equal(reply?.content, LONG_REPLY, 'текст ответа не обрезается');
  } finally {
    closeConnection();
    forgetTranscriptTail();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('история: номер разговора есть, файла нет — признак transcriptMissing', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const directory = await mkdtemp(path.join(tmpdir(), 'history-missing-'));
  const missingId = '128968a5-d642-4295-922a-f16f5818c312';

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  process.env.CLAUDE_CONFIG_DIR = directory;
  await initializeDatabase();

  try {
    sessionsDb.createSession(missingId, 'claude', PROJECT_PATH);
    const page = await new ClaudeSessionsProvider().fetchHistory(missingId, {
      limit: 60,
      offset: 0,
      providerSessionId: missingId,
      projectPath: PROJECT_PATH,
    });
    assert.equal(page.messages.length, 0);
    assert.equal(page.transcriptMissing, true, 'лента должна объяснить, что переписка не сохранилась');
  } finally {
    closeConnection();
    for (const [key, value] of [['DATABASE_PATH', previousDatabasePath], ['CLAUDE_CONFIG_DIR', previousConfigDir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
