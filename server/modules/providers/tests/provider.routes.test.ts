import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session creation route names a CloudCLI session from the initial message', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        projectPath: workspacePath,
        initialMessage: 'abcd  efg\nhij klm nop',
      }),
    });
    const payload = await response.json() as {
      data: { sessionId: string; sessionName: string };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.data.sessionName, 'abcd efg hij klm');
    assert.equal(
      sessionsDb.getSessionById(payload.data.sessionId)?.custom_name,
      'abcd efg hij klm',
    );
  });
});

test('conversation search streams title matches before transcript results', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession(
      'title-only-session',
      'codex',
      workspacePath,
      'Release planning notes',
    );
    const transcriptPath = path.join(path.dirname(workspacePath), 'codex-search.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-12T09:00:00.000Z',
      payload: {
        type: 'user_message',
        kind: 'plain',
        message: 'Release planning also appears in this conversation.',
      },
    })}\n`);
    sessionsDb.createSession(
      'transcript-session',
      'codex',
      workspacePath,
      'Unrelated session',
      undefined,
      undefined,
      transcriptPath,
    );

    const response = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=release%20planning&limit=50`,
    );
    const eventStream = await response.text();
    const titleEventIndex = eventStream.indexOf('event: title-results');
    const conversationEventIndex = eventStream.indexOf('event: result');
    const doneEventIndex = eventStream.indexOf('event: done');

    assert.equal(response.status, 200);
    assert.ok(titleEventIndex >= 0);
    assert.ok(conversationEventIndex > titleEventIndex);
    assert.ok(doneEventIndex > titleEventIndex);

    const titleDataLine = eventStream
      .slice(titleEventIndex, conversationEventIndex)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(titleDataLine);

    const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
      titleResults: Array<{
        sessionId: string;
        sessionTitle: string;
        provider: string;
      }>;
    };
    assert.equal(titlePayload.titleResults.length, 1);
    assert.equal(titlePayload.titleResults[0]?.sessionId, 'title-only-session');
    assert.equal(titlePayload.titleResults[0]?.sessionTitle, 'Release planning notes');
    assert.equal(titlePayload.titleResults[0]?.provider, 'codex');
  });
});

test('reasoning effort is persisted and returned with the active session model', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('effort-session', 'codex', workspacePath);

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'ultra' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { effort: string; sessionId: string };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.effort, 'ultra');
    assert.equal(sessionsDb.getSessionById('effort-session')?.effort, 'ultra');

    const readResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-model`,
    );
    const readPayload = await readResponse.json() as {
      data: { effort: string | null; sessionId: string };
    };

    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.data.sessionId, 'effort-session');
    assert.equal(readPayload.data.effort, 'ultra');
  });
});

test('model routes expose immutable defaults and full custom model CRUD', async () => {
  await withProviderServer(async (baseUrl) => {
    const initialResponse = await fetch(`${baseUrl}/api/providers/codex/models`);
    const initialPayload = await initialResponse.json() as {
      data: {
        cache?: unknown;
        models: {
          OPTIONS: Array<{ recordId?: number; value: string; isCustom: boolean }>;
        };
      };
    };
    assert.equal(initialResponse.status, 200);
    assert.equal('cache' in initialPayload.data, false);
    const predefined = initialPayload.data.models.OPTIONS[0];
    assert.equal(predefined.isCustom, false);
    assert.equal(predefined.recordId, undefined);

    const createResponse = await fetch(`${baseUrl}/api/providers/codex/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Gateway GPT', id: 'gateway/gpt' }),
    });
    const createPayload = await createResponse.json() as {
      data: { model: { recordId: number; value: string; label: string; isCustom: boolean } };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.data.model.isCustom, true);
    const customRecordId = createPayload.data.model.recordId;

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Gateway GPT Updated', id: 'gateway/gpt-v2' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { model: { value: string; label: string } };
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.model.value, 'gateway/gpt-v2');
    assert.equal(updatePayload.data.model.label, 'Gateway GPT Updated');

    const immutableResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/999999`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Changed', id: 'changed' }),
      },
    );
    const immutablePayload = await immutableResponse.json() as { error: { code: string } };
    assert.equal(immutableResponse.status, 404);
    assert.equal(immutablePayload.error.code, 'MODEL_NOT_FOUND');

    const deleteResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      { method: 'DELETE' },
    );
    const deletePayload = await deleteResponse.json() as {
      data: { models: { OPTIONS: Array<{ recordId: number }> } };
    };
    assert.equal(deleteResponse.status, 200);
    assert.equal(
      deletePayload.data.models.OPTIONS.some((option) => option.recordId === customRecordId),
      false,
    );
  });
});

test('conversation search reads only the asked folder and picks up new messages', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const otherWorkspace = `${workspacePath}-other`;
    const claudeLine = (sessionId: string, uuid: string, role: 'user' | 'assistant', text: string) => `${JSON.stringify({
      type: role,
      sessionId,
      uuid,
      timestamp: '2026-09-23T07:00:00.000Z',
      message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    })}\n`;

    const mainTranscript = path.join(path.dirname(workspacePath), 'main.jsonl');
    await writeFile(mainTranscript, claudeLine('claude-main', 'u1', 'user', 'Где лежит отчёт про солнечную школу?')
      + `${JSON.stringify({ type: 'user', sessionId: 'claude-main', message: { role: 'user', content: [{ type: 'tool_result', content: 'солнечную '.repeat(50) }] } })}\n`);
    sessionsDb.createSession('claude-main', 'claude', workspacePath, 'Отчёты', undefined, undefined, mainTranscript);

    const otherTranscript = path.join(path.dirname(workspacePath), 'other.jsonl');
    await writeFile(otherTranscript, claudeLine('claude-other', 'u9', 'user', 'Про солнечную школу тоже'));
    sessionsDb.createSession('claude-other', 'claude', otherWorkspace, 'Чужая папка', undefined, undefined, otherTranscript);

    const projectId = projectsDb.getProjectPath(workspacePath)?.project_id;
    assert.ok(projectId);

    const search = async (q: string) => {
      const response = await fetch(
        `${baseUrl}/api/providers/search/sessions?q=${encodeURIComponent(q)}&limit=50&projectId=${projectId}`,
      );
      const stream = await response.text();
      return stream
        .split('\n\n')
        .filter((block) => block.startsWith('event: result'))
        .map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) as {
          projectResult: { projectId: string; sessions: Array<{ sessionId: string; matches: Array<{ snippet: string; messageUuid?: string }> }> };
        });
    };

    const first = await search('солнечную');
    assert.equal(first.length, 1);
    assert.equal(first[0].projectResult.projectId, projectId);
    assert.equal(first[0].projectResult.sessions[0].sessionId, 'claude-main');
    // Вывод инструмента в выжимку не попадает — одна находка, из сообщения.
    assert.equal(first[0].projectResult.sessions[0].matches.length, 1);
    assert.equal(first[0].projectResult.sessions[0].matches[0].messageUuid, 'u1');

    assert.equal((await search('лунную')).length, 0);
    await appendFile(mainTranscript, claudeLine('claude-main', 'u2', 'assistant', 'Про лунную школу отчёта нет'));
    const afterAppend = await search('лунную');
    assert.equal(afterAppend.length, 1);
    assert.equal(afterAppend[0].projectResult.sessions[0].matches[0].messageUuid, 'u2');

    // Два разговора в одном файле: поздний находится, даже если в раннем
    // слово встречается сотни раз.
    const sharedTranscript = path.join(path.dirname(workspacePath), 'shared.jsonl');
    let sharedLines = '';
    for (let i = 0; i < 200; i += 1) {
      sharedLines += claudeLine('claude-early', `e${i}`, 'user', `звезда номер ${i}`);
    }
    sharedLines += claudeLine('claude-late', 'late1', 'user', 'звезда в позднем разговоре');
    await writeFile(sharedTranscript, sharedLines);
    sessionsDb.createSession('claude-early', 'claude', workspacePath, 'Ранний', undefined, undefined, sharedTranscript);
    sessionsDb.createSession('claude-late', 'claude', workspacePath, 'Поздний', undefined, undefined, sharedTranscript);
    const shared = (await search('звезда')).flatMap((event) => event.projectResult.sessions.map((s) => s.sessionId));
    assert.ok(shared.includes('claude-early'));
    assert.ok(shared.includes('claude-late'));
  });
});
