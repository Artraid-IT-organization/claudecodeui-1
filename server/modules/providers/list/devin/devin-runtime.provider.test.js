import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, devinConnectionsDb, initializeDatabase } from '@/modules/database/index.js';

import { devinRuntime } from './devin-runtime.provider.js';
import { DevinSessionsProvider, mapPermissionModeToDevinMode } from './devin-sessions.provider.js';

const sessionsProvider = new DevinSessionsProvider();
const runtimeContext = {
  resolveProviderSessionId: (sessionId) => sessionId === 'app-resume' ? 'devin-sess-1' : null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

/**
 * A fake `devin` binary that speaks just enough ACP: answers initialize /
 * session/new / session/load / session/set_* on stdin, streams a couple of
 * session/update notifications, then answers session/prompt. All requests are
 * captured to DEVIN_RPC_CAPTURE for assertions. Prompts hang forever when
 * DEVIN_HANG=1 (used to test abort).
 */
async function createFakeDevinExecutable(binDir) {
  const scriptPath = path.join(binDir, 'devin.js');
  await writeFile(scriptPath, `
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const cap = process.env.DEVIN_RPC_CAPTURE;
const seen = [];
const record = (m) => { seen.push(m); if (cap) fs.writeFileSync(cap, JSON.stringify({ args: process.argv.slice(2), calls: seen }, null, 2)); };
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');
const request = (id, method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');

let pendingPrompt = null; // msg.id of session/prompt waiting on permission
let promptCount = 0; // сколько session/prompt получил этот процесс (для сценариев продолжения)
const finishPrompt = () => {
  if (!pendingPrompt) return;
  const { id, sid } = pendingPrompt;
  pendingPrompt = null;
  notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AFTER-PERMISSION' } } });
  respond(id, { stopReason: 'end_turn' });
  setTimeout(() => process.exit(0), 1000);
};

rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method === undefined) {
    // Answer to OUR request (session/request_permission).
    record({ answer: msg });
    if (pendingPrompt) finishPrompt();
    return;
  }
  if (msg.method === undefined || msg.id === undefined) {
    record(msg); return; // notifications (session/cancel)
  }
  record(msg);
  switch (msg.method) {
    case 'initialize':
      respond(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      break;
    case 'session/new':
      respond(msg.id, { sessionId: 'devin-sess-1' });
      break;
    case 'session/load':
      if (process.env.DEVIN_SESSION_LOCKED === '1') {
        // Живой ответ Devin 10.10.26: сессию держит процесс прошлого хода.
        if (process.env.DEVIN_TURN_LOG) fs.appendFileSync(process.env.DEVIN_TURN_LOG, JSON.stringify({ locked: true, xdg: process.env.XDG_DATA_HOME }) + '\\n');
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32015, message: "Session '" + msg.params.sessionId + "' is already open in another process (PID 291819). Close the other instance before opening it here.", data: { 'cognition.ai/errorKind': 'session_locked' } } }) + '\\n');
        break;
      }
      // Replayed history MUST be muted by the runtime.
      notify('session/update', { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-OLD-TEXT' } } });
      notify('session/update', { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Как я понял задачу\\n\\nСейчас проверю данные.' } } });
      respond(msg.id, { sessionId: msg.params.sessionId });
      break;
    case 'session/set_mode':
    case 'session/set_config_option':
      respond(msg.id, {});
      break;
    case 'session/prompt': {
      if (process.env.DEVIN_HANG === '1') return; // never answer → abort test
      const sid = msg.params.sessionId;
      promptCount += 1;
      // Подписка = credentials.toml под XDG_DATA_HOME процесса; «limited» — исчерпана.
      const credPath = require('node:path').join(process.env.XDG_DATA_HOME || '', 'devin', 'credentials.toml');
      const cred = fs.existsSync(credPath) ? fs.readFileSync(credPath, 'utf8') : '';
      if (process.env.DEVIN_TURN_LOG) {
        fs.appendFileSync(process.env.DEVIN_TURN_LOG, JSON.stringify({ xdg: process.env.XDG_DATA_HOME, cred: cred.trim(), methods: seen.map((m) => m.method) }) + '\\n');
      }
      if (process.env.DEVIN_REJECT_MODEL && process.argv.includes(process.env.DEVIN_REJECT_MODEL)) {
        // Живой формат отказа модели (журнал 13.10.26, adaptive в чате с историей SWE-2): ошибка на prompt, до вывода.
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32013, message: 'Client error: Protocol error (invalid_argument): There is an issue with this request, please try a different model. (trace ID: 9074a8d8c7a08d1b)', data: { 'cognition.ai/retryable': true } } }) + '\\n');
        return;
      }
      if (cred.includes('limited')) {
        // Живой формат лимита Devin (журнал cc2 09.10.26): ошибка на prompt, до вывода.
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32010, message: 'Reached free model rate limit. Your limit will reset in 34 minutes (at 21:01 UTC). (trace ID: afd89c403f6c)' } }) + '\\n');
        return;
      }
      if (process.env.DEVIN_PERMISSION_TEST === '1') {
        // Ask permission and hold the prompt until the client answers.
        pendingPrompt = { id: msg.id, sid };
        request(900, 'session/request_permission', {
          sessionId: sid,
          // Живой урезанный формат Devin (замерено 03.10.26): без title/rawInput.
          toolCall: { toolCallId: 'tc-perm', _meta: { 'cognition.ai/editableCommand': 'rm -rf /tmp/x' } },
          options: [
            { optionId: 'o-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'o-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'o-reject', name: 'Reject', kind: 'reject_once' },
          ],
        });
        return;
      }
      if (process.env.DEVIN_INCOMPLETE === 'understanding') {
        notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Как я понял задачу\\n\\nСейчас проверю данные.' } } });
        respond(msg.id, { stopReason: 'end_turn' });
        setTimeout(() => process.exit(0), 1000);
        return;
      }
      if (process.env.DEVIN_INCOMPLETE === 'recover') {
        // Первый prompt обрывается статусом; каждое служебное продолжение
        // доводит ход до результата.
        if (promptCount === 1) {
          notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Как я понял задачу\\n\\nСейчас проверю данные.' } } });
        } else {
          notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Ответ\\n\\nПроверка завершена, результат готов.' } } });
        }
        respond(msg.id, { stopReason: 'end_turn' });
        setTimeout(() => process.exit(0), 1000);
        return;
      }
      if (process.env.DEVIN_INCOMPLETE === 'pending_work') {
        // Реальный обрыв twilight-ursinia (22.10): структурированный пересказ
        // состояния, заканчивающийся объявленным своим шагом — раньше проходил
        // эвристику как «полный» из-за списков.
        if (promptCount === 1) {
          notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Где сейчас работа:\\n\\n- Ветка от develop, базовый контракт закоммичен.\\n- В дереве незакоммиченная правка парсера.\\n- Найденный риск: ложные отказы рождаются в intake.\\n- Автоотказ никуда не подключён.\\n- На проде не изменено ничего.\\n\\nДальше: дожму и закоммичу правку, затем разбор intake и прогон обработчика.' } } });
        } else {
          notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Ответ\\n\\nПравка закоммичена, обработчик прогнан, всё проверено.' } } });
        }
        respond(msg.id, { stopReason: 'end_turn' });
        setTimeout(() => process.exit(0), 1000);
        return;
      }
      if (process.env.DEVIN_INCOMPLETE === 'same_incomplete_repeat') {
        // Модель упорно повторяет тот же вопрос-разрешение — это её осознанный
        // ответ, а не обрыв: один пинок, затем штатное завершение без ошибки.
        notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Состояние не изменилось. Продолжаю?' } } });
        respond(msg.id, { stopReason: 'end_turn' });
        setTimeout(() => process.exit(0), 1000);
        return;
      }
      if (process.env.DEVIN_INCOMPLETE === 'tool_only') {
        notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Проверяю данные.' } } });
        notify('session/update', { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-incomplete', title: 'Read', kind: 'read' } });
        respond(msg.id, { stopReason: 'end_turn' });
        setTimeout(() => process.exit(0), 1000);
        return;
      }
      if (process.env.DEVIN_INCOMPLETE === 'complete_after_status') {
        notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Сейчас проверю данные.\\n\\n## Ответ\\n\\nПроверка завершена, результат готов.' } } });
        respond(msg.id, { stopReason: 'end_turn' });
        setTimeout(() => process.exit(0), 1000);
        return;
      }
      if (process.env.DEVIN_INCOMPLETE === 'late_final_chunk') {
        notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Как я понял задачу\\n\\nСейчас проверю данные.' } } });
        respond(msg.id, { stopReason: 'end_turn' });
        setTimeout(() => notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\\n\\n## Ответ\\n\\nПроверка завершена, результат готов.' } } }), 25);
        setTimeout(() => process.exit(0), 150);
        return;
      }
      if (process.env.DEVIN_INCOMPLETE === 'structured_answer') {
        // Реалистичный ответ из проекта «Промпты»: разделы Логика, Готовый промпт,
        // Возможные улучшения, Версия «Максимум» — без заголовков из старого whitelist.
        notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Логика\\n\\n- Прежний поиск был слишком узким.\\n- Новый поиск строится в два этапа.\\n\\n## Готовый промпт\\n\\nТы — исследователь рынка. Проведи глубокий поиск.\\n\\n## Возможные улучшения\\n\\n- Добавить фото волос.\\n- Указать бюджет.\\n\\n## Версия «Максимум»\\n\\nОсновной вариант уже максимальный для задачи.' } } });
        respond(msg.id, { stopReason: 'end_turn' });
        setTimeout(() => process.exit(0), 1000);
        return;
      }
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking hard' } } });
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LIVE-REPLY' } } });
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 100, size: 200000 } });
      const stopReason = process.env.DEVIN_INCOMPLETE === 'max_tokens'
        ? 'max_tokens'
        : process.env.DEVIN_INCOMPLETE === 'refusal' ? 'refusal' : 'end_turn';
      respond(msg.id, { stopReason, usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 } });
      setTimeout(() => process.exit(0), 1000);
      break;
    }
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } }) + '\\n');
  }
});
`, 'utf8');

  const shim = path.join(binDir, 'devin');
  await writeFile(shim, '#!/bin/sh\nexec node "$(dirname "$0")/devin.js" "$@"\n', 'utf8');
  await chmod(shim, 0o755);
  return shim;
}

function makeWriter() {
  const messages = [];
  return {
    messages,
    sessionId: null,
    userId: null,
    send(message) { messages.push(message); },
    setSessionId(sessionId) { this.sessionId = sessionId; },
  };
}

async function withFakeDevin(fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'devin-cli-test-'));
  const previousCliPath = process.env.DEVIN_CLI_PATH;
  const previousCapture = process.env.DEVIN_RPC_CAPTURE;
  const previousHang = process.env.DEVIN_HANG;
  const previousPermTest = process.env.DEVIN_PERMISSION_TEST;
  const previousIncomplete = process.env.DEVIN_INCOMPLETE;
  const previousRunsDir = process.env.CLOUDCLI_DEVIN_RUNS_DIR;
  const previousLiveRuns = process.env.CLOUDCLI_LIVE_RUNS_DIR;
  const previousDbPath = process.env.DATABASE_PATH;
  const shim = await createFakeDevinExecutable(tempRoot);
  process.env.DEVIN_CLI_PATH = shim;
  process.env.DEVIN_RPC_CAPTURE = path.join(tempRoot, 'rpc.json');
  // Супервизор и live-runs пишут в свои каталоги — в тестах они во временных.
  process.env.CLOUDCLI_DEVIN_RUNS_DIR = path.join(tempRoot, 'devin-runs');
  process.env.CLOUDCLI_LIVE_RUNS_DIR = path.join(tempRoot, 'live-runs');

  // Connection Layer читает sessions/devin_connections — изолированная база.
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  // Тестовый канал с собственным XDG_DATA_HOME: креда там есть (содержимое
  // неважно — CLI подменён), рантайм выберет его первым годным.
  const connXdg = path.join(tempRoot, 'conn-xdg');
  await writeFile(path.join(tempRoot, 'creds.toml'), 'windsurf_api_key = "test"\n', 'utf8');
  const fsSync = await import('node:fs');
  fsSync.mkdirSync(path.join(connXdg, 'devin'), { recursive: true });
  fsSync.writeFileSync(path.join(connXdg, 'devin', 'credentials.toml'), 'windsurf_api_key = "test"\n');
  devinConnectionsDb.create({ name: 'test-conn', xdgDataHome: connXdg });

  try {
    await fn(tempRoot);
  } finally {
    closeConnection();
    if (previousCliPath === undefined) delete process.env.DEVIN_CLI_PATH; else process.env.DEVIN_CLI_PATH = previousCliPath;
    if (previousCapture === undefined) delete process.env.DEVIN_RPC_CAPTURE; else process.env.DEVIN_RPC_CAPTURE = previousCapture;
    if (previousHang === undefined) delete process.env.DEVIN_HANG; else process.env.DEVIN_HANG = previousHang;
    if (previousPermTest === undefined) delete process.env.DEVIN_PERMISSION_TEST; else process.env.DEVIN_PERMISSION_TEST = previousPermTest;
    if (previousIncomplete === undefined) delete process.env.DEVIN_INCOMPLETE; else process.env.DEVIN_INCOMPLETE = previousIncomplete;
    if (previousRunsDir === undefined) delete process.env.CLOUDCLI_DEVIN_RUNS_DIR; else process.env.CLOUDCLI_DEVIN_RUNS_DIR = previousRunsDir;
    if (previousLiveRuns === undefined) delete process.env.CLOUDCLI_LIVE_RUNS_DIR; else process.env.CLOUDCLI_LIVE_RUNS_DIR = previousLiveRuns;
    if (previousDbPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDbPath;
    // Супервизор может дописывать свои файлы в devin-runs чуть позже нас —
    // rm без ретраев падает с ENOTEMPTY.
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Дождаться условия (опрос каждые 25 мс) или бросить по таймауту. */
async function waitFor(check, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

test('devin runtime: new session — handshake, session_created, streamed deltas, complete', async () => {
  await withFakeDevin(async (tempRoot) => {
    const writer = makeWriter();
    await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-new-1' }, writer, runtimeContext);

    const kinds = writer.messages.map((m) => m.kind);
    assert.equal(writer.sessionId, 'devin-sess-1', 'setSessionId got the provider id');
    assert.ok(kinds.indexOf('session_created') < kinds.indexOf('stream_delta'), 'session_created before deltas');
    assert.ok(writer.messages.some((m) => m.kind === 'thinking_delta' && m.content === 'thinking hard'));
    assert.ok(writer.messages.some((m) => m.kind === 'stream_delta' && m.content === 'LIVE-REPLY'));
    assert.ok(writer.messages.some((m) => m.kind === 'status' && m.tokenBudget));
    const completes = writer.messages.filter((m) => m.kind === 'complete');
    assert.equal(completes.length, 1, 'exactly one complete');
    assert.equal(completes[0].exitCode, 0);
    assert.ok(!writer.messages.some((m) => m.content === 'REPLAYED-OLD-TEXT'), 'no replayed text');

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const methods = capture.calls.map((c) => c.method);
    assert.deepEqual(methods.slice(0, 2), ['initialize', 'session/new']);
    // Пустая модель клампится в swe-2-high ещё до спауна — иначе Devin взял бы свой конфиг.
    assert.deepEqual(capture.args, ['acp', '--model', 'swe-2-high']);
  });
});

test('devin runtime: recoverable stalls auto-continue via a marked service prompt, then fail visibly', async () => {
  for (const scenario of ['understanding', 'tool_only', 'max_tokens']) {
    await withFakeDevin(async (tempRoot) => {
      process.env.DEVIN_INCOMPLETE = scenario;
      const writer = makeWriter();

      await assert.rejects(() => devinRuntime.run(
        'Original user request',
        { cwd: tempRoot, sessionId: `app-incomplete-${scenario}` },
        writer,
        runtimeContext,
      ));

      const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
      const prompts = capture.calls.filter((call) => call.method === 'session/prompt');
      // Исходный запрос + не более двух служебных продолжений с меткой.
      assert.equal(prompts.length, 3, `${scenario}: original prompt plus capped auto-continues`);
      assert.equal(prompts[0].params.prompt[0].text, 'Original user request');
      for (const continuation of prompts.slice(1)) {
        assert.ok(
          continuation.params.prompt[0].text.includes('cc2-auto-continue'),
          `${scenario}: continuation prompt carries the service marker`,
        );
      }
      assert.ok(
        writer.messages.some((message) => message.kind === 'status' && /продолжаю автоматически/i.test(message.text || '')),
        `${scenario}: a subtle auto-continue status is shown`,
      );
      assert.ok(writer.messages.some((message) => message.kind === 'error'), `${scenario}: error is visible`);
      const completes = writer.messages.filter((message) => message.kind === 'complete');
      assert.equal(completes.length, 1, `${scenario}: exactly one terminal complete`);
      assert.equal(completes[0].exitCode, 1, `${scenario}: still-incomplete output is not success`);
    });
  }
});

test('devin runtime: waits for a final chunk delivered just after session/prompt resolves', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_INCOMPLETE = 'late_final_chunk';
    const writer = makeWriter();

    await devinRuntime.run(
      'Original user request',
      { cwd: tempRoot, sessionId: 'app-late-final' },
      writer,
      runtimeContext,
    );

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const prompts = capture.calls.filter((call) => call.method === 'session/prompt');
    assert.equal(prompts.length, 1, 'late final output must not trigger a synthetic continuation');
    assert.ok(writer.messages.some((message) => message.kind === 'stream_delta' && /Проверка завершена/.test(message.content || '')));
    assert.ok(!writer.messages.some((message) => message.kind === 'error'));
    const completes = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].exitCode, 0);
  });
});

test('devin runtime: refusal fails without any continuation prompt', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_INCOMPLETE = 'refusal';
    const writer = makeWriter();

    await assert.rejects(() => devinRuntime.run(
      'Original user request',
      { cwd: tempRoot, sessionId: 'app-incomplete-refusal' },
      writer,
      runtimeContext,
    ));

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const prompts = capture.calls.filter((call) => call.method === 'session/prompt');
    assert.equal(prompts.length, 1, 'refusal: only the original prompt is sent');
    assert.ok(writer.messages.some((message) => message.kind === 'error'));
    const completes = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].exitCode, 1);
  });
});

test('devin runtime: a stalled first answer recovers via auto-continue without a visible user message', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_INCOMPLETE = 'recover';
    const writer = makeWriter();

    await devinRuntime.run(
      'Original user request',
      { cwd: tempRoot, sessionId: 'app-recover' },
      writer,
      runtimeContext,
    );

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const prompts = capture.calls.filter((call) => call.method === 'session/prompt');
    assert.equal(prompts.length, 2, 'one continuation was needed');
    assert.equal(prompts[0].params.prompt[0].text, 'Original user request');
    assert.ok(prompts[1].params.prompt[0].text.includes('cc2-auto-continue'));
    // В ленте нет реплики от имени человека — только статус и финальный текст.
    assert.ok(!writer.messages.some((message) => message.role === 'user' && /продолж/i.test(message.content || '')));
    assert.ok(writer.messages.some((message) => message.kind === 'status' && /продолжаю автоматически/i.test(message.text || '')));
    assert.ok(!writer.messages.some((message) => message.kind === 'error'));
    const completes = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].exitCode, 0);
  });
});

test('devin runtime: recap with declared own next step auto-continues (twilight-ursinia regression)', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_INCOMPLETE = 'pending_work';
    const writer = makeWriter();

    await devinRuntime.run('Проверь телефоны в CRM', { cwd: tempRoot, sessionId: 'app-pending-work' }, writer, runtimeContext);

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const prompts = capture.calls.filter((call) => call.method === 'session/prompt');
    assert.equal(prompts.length, 2, 'structured recap declaring own work must be continued');
    assert.ok(prompts[1].params.prompt[0].text.includes('cc2-auto-continue'));
    assert.ok(!writer.messages.some((message) => message.kind === 'error'));
    const completes = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completes[0].exitCode, 0);
  });
});

test('devin runtime: repeated identical pending tail ends the turn cleanly, no error', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_INCOMPLETE = 'same_incomplete_repeat';
    const writer = makeWriter();

    await devinRuntime.run('Статус?', { cwd: tempRoot, sessionId: 'app-repeat-tail' }, writer, runtimeContext);

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const prompts = capture.calls.filter((call) => call.method === 'session/prompt');
    assert.equal(prompts.length, 2, 'one auto-continue, then the deliberate answer stands');
    assert.ok(!writer.messages.some((message) => message.kind === 'error'), 'conscious repeat is not a failure');
    const completes = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completes[0].exitCode, 0);
  });
});

test('devin runtime: a status followed by a result remains successful', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_INCOMPLETE = 'complete_after_status';
    const writer = makeWriter();

    await devinRuntime.run('Original user request', { cwd: tempRoot, sessionId: 'app-complete-after-status' }, writer, runtimeContext);

    assert.ok(!writer.messages.some((message) => message.kind === 'error'));
    const completes = writer.messages.filter((message) => message.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].exitCode, 0);
  });
});

test('devin runtime: resume — session/load replays are muted, no session_created', async () => {
  await withFakeDevin(async (tempRoot) => {
    const writer = makeWriter();
    await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-resume' }, writer, runtimeContext);

    const methods = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'))
      .calls.map((c) => c.method);
    assert.ok(methods.includes('session/load'));
    assert.ok(!methods.includes('session/new'));
    assert.ok(!writer.messages.some((m) => m.kind === 'session_created'), 'no session_created on resume');
    assert.ok(!writer.messages.some((m) => m.content === 'REPLAYED-OLD-TEXT'), 'load replay muted');
    assert.ok(writer.messages.some((m) => m.content === 'LIVE-REPLY'));
    assert.equal(writer.messages.filter((m) => m.kind === 'complete').length, 1);
  });
});

/**
 * Две подписки: канал test-conn (линия, его креда «исчерпана») и spare.
 * Возвращает id каналов и путь журнала ходов фейкового CLI.
 */
async function setupExhaustedLane(tempRoot, { hostSession }) {
  const fsSync = await import('node:fs');
  process.env.DEVIN_CONNECTIONS_ROOT = path.join(tempRoot, 'connections');
  process.env.DEVIN_TURN_LOG = path.join(tempRoot, 'turns.jsonl');
  const laneXdg = path.join(tempRoot, 'conn-xdg');
  fsSync.writeFileSync(path.join(laneXdg, 'devin', 'credentials.toml'), 'windsurf_api_key = "limited"\n');
  if (hostSession) {
    // sessions.db линии знает devin-sess-1 — по ней рантайм находит линию чата.
    fsSync.mkdirSync(path.join(laneXdg, 'devin', 'cli'), { recursive: true });
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(laneXdg, 'devin', 'cli', 'sessions.db'));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('devin-sess-1');");
    db.close();
  }
  const spareXdg = path.join(tempRoot, 'spare-xdg');
  fsSync.mkdirSync(path.join(spareXdg, 'devin'), { recursive: true });
  fsSync.writeFileSync(path.join(spareXdg, 'devin', 'credentials.toml'), 'windsurf_api_key = "fresh"\n');
  const lane = devinConnectionsDb.getByName('test-conn');
  const spare = devinConnectionsDb.create({ name: 'spare', priority: 1, xdgDataHome: spareXdg });
  const readTurns = async () => (await readFile(process.env.DEVIN_TURN_LOG, 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  return { lane, spare, laneXdg, readTurns };
}

function restoreLaneEnv() {
  delete process.env.DEVIN_CONNECTIONS_ROOT;
  delete process.env.DEVIN_TURN_LOG;
}

test('devin runtime: лимит подписки — существующий чат продолжается на другой подписке в той же линии', async () => {
  await withFakeDevin(async (tempRoot) => {
    try {
      const { lane, spare, laneXdg, readTurns } = await setupExhaustedLane(tempRoot, { hostSession: true });
      const writer = makeWriter();
      await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-resume' }, writer, runtimeContext);

      const turns = await readTurns();
      assert.equal(turns.length, 2, 'одна попытка на исчерпанной, одна на запасной');
      assert.equal(turns[0].xdg, laneXdg);
      assert.match(turns[0].cred, /limited/);
      assert.notEqual(turns[1].xdg, laneXdg, 'вторая попытка — через тень линии');
      assert.match(turns[1].cred, /fresh/, 'платит запасная подписка');
      assert.ok(turns[1].methods.includes('session/load'), 'та же сессия грузится из линии');
      const fsSync = await import('node:fs');
      assert.equal(fsSync.realpathSync(path.join(turns[1].xdg, 'devin', 'cli')), fsSync.realpathSync(path.join(laneXdg, 'devin', 'cli')));

      assert.ok(writer.messages.some((m) => m.kind === 'status' && /исчерпан лимит/.test(m.text || '')), 'человек видит переход');
      assert.ok(writer.messages.some((m) => m.content === 'LIVE-REPLY'), 'ответ дошёл');
      assert.ok(!writer.messages.some((m) => m.kind === 'error'), 'без ошибки');
      const completes = writer.messages.filter((m) => m.kind === 'complete');
      assert.equal(completes.length, 1);
      assert.equal(completes[0].exitCode, 0);
      assert.equal(devinConnectionsDb.getById(lane.id).health_status, 'rate_limited', 'исчерпанная подписка ушла в cooldown');
      assert.equal(devinConnectionsDb.getById(spare.id).health_status, 'ok');
    } finally {
      restoreLaneEnv();
    }
  });
});

test('devin runtime: новый чат упёрся в лимит после session/new — повтор грузит ту же сессию, без второго session_created', async () => {
  await withFakeDevin(async (tempRoot) => {
    try {
      const { readTurns } = await setupExhaustedLane(tempRoot, { hostSession: false });
      const writer = makeWriter();
      await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-new-1' }, writer, runtimeContext);

      const turns = await readTurns();
      assert.equal(turns.length, 2);
      assert.ok(turns[0].methods.includes('session/new'));
      assert.ok(turns[1].methods.includes('session/load'), 'повтор продолжает выделенную сессию');
      assert.ok(!turns[1].methods.includes('session/new'), 'вторую сессию не заводит');
      assert.equal(writer.messages.filter((m) => m.kind === 'session_created').length, 1);
      assert.ok(writer.messages.some((m) => m.content === 'LIVE-REPLY'));
      assert.equal(writer.messages.filter((m) => m.kind === 'complete').length, 1);
    } finally {
      restoreLaneEnv();
    }
  });
});

test('devin runtime: сессию держит прошлый ход — без перебора подписок и без штрафа им, человеку понятная ошибка', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_SESSION_LOCKED = '1';
    try {
      const { lane, spare, readTurns } = await setupExhaustedLane(tempRoot, { hostSession: true });
      devinConnectionsDb.markHealth(lane.id, 'ok', { lastError: null });
      const fsSync = await import('node:fs');
      fsSync.writeFileSync(path.join(tempRoot, 'conn-xdg', 'devin', 'credentials.toml'), 'windsurf_api_key = "ok"\n');
      const writer = makeWriter();
      await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-resume' }, writer, runtimeContext).catch(() => {});

      assert.equal((await readTurns()).length, 1, 'одна попытка — другие подписки замок не снимут');
      const errors = writer.messages.filter((m) => m.kind === 'error');
      assert.equal(errors.length, 1);
      assert.match(errors[0].content, /чат ещё занят/);
      assert.equal(writer.messages.filter((m) => m.kind === 'complete').length, 1);
      assert.equal(devinConnectionsDb.getById(lane.id).health_status, 'ok', 'подписка линии не штрафуется');
      assert.equal(devinConnectionsDb.getById(spare.id).health_status, 'unknown');
    } finally {
      delete process.env.DEVIN_SESSION_LOCKED;
      restoreLaneEnv();
    }
  });
});

test('devin runtime: model + permission mode are passed to the agent', async () => {
  await withFakeDevin(async (tempRoot) => {
    const writer = makeWriter();
    await devinRuntime.run('Hi', {
      cwd: tempRoot,
      sessionId: 'app-model-1',
      model: 'swe-2-max',
      permissionMode: 'bypassPermissions',
    }, writer, runtimeContext);

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    // bypassPermissions → CLI flag `devin --permission-mode dangerous acp`
    // covers the spawn→set_mode window (the acp subcommand has no such flag).
    assert.deepEqual(capture.args, ['--permission-mode', 'dangerous', 'acp', '--model', 'swe-2-max']);
    const setMode = capture.calls.find((c) => c.method === 'session/set_mode');
    assert.equal(setMode?.params?.modeId, 'bypass');
    const setModel = capture.calls.find((c) => c.method === 'session/set_config_option');
    assert.equal(setModel?.params?.value, 'swe-2-max');
  });
});

test('devin runtime: fusion-* and legacy MODEL_* ids are replaced by swe-2-high', async () => {
  for (const forbidden of ['fusion-claude-opus-5-5-medium-sidekick-swe-2-medium', 'MODEL_GPT_5_2_LOW']) {
    await withFakeDevin(async (tempRoot) => {
      const writer = makeWriter();
      await devinRuntime.run('Hi', {
        cwd: tempRoot,
        sessionId: `app-forbidden-${forbidden}`,
        model: forbidden,
        permissionMode: 'default',
      }, writer, runtimeContext);

      const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
      assert.deepEqual(capture.args, ['acp', '--model', 'swe-2-high'], `model ${forbidden} must not reach the agent`);
      const setModel = capture.calls.find((c) => c.method === 'session/set_config_option');
      assert.equal(setModel?.params?.value, 'swe-2-high');
    });
  }
});

test('devin runtime: adaptive and ordinary catalog models are allowed and reach the agent as picked', async () => {
  for (const picked of ['adaptive', 'claude-haiku-5-5-medium']) {
    await withFakeDevin(async (tempRoot) => {
      const writer = makeWriter();
      await devinRuntime.run('Hi', {
        cwd: tempRoot,
        sessionId: `app-allowed-${picked}`,
        model: picked,
        permissionMode: 'default',
      }, writer, runtimeContext);

      const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
      assert.deepEqual(capture.args, ['acp', '--model', picked]);
      const setModel = capture.calls.find((c) => c.method === 'session/set_config_option');
      assert.equal(setModel?.params?.value, picked);
    });
  }
});

test('devin runtime: model rejected with invalid_argument is retried once on swe-2-high, same subscription', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_REJECT_MODEL = 'adaptive';
    try {
      const writer = makeWriter();
      await devinRuntime.run('Hi', {
        cwd: tempRoot,
        sessionId: 'app-model-reject',
        model: 'adaptive',
        permissionMode: 'default',
      }, writer, runtimeContext);

      const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
      assert.deepEqual(capture.args, ['acp', '--model', 'swe-2-high'], 'повтор идёт на swe-2-high');
      const errors = writer.messages.filter((m) => m.kind === 'error');
      assert.equal(errors.length, 0, 'человек не видит красной ошибки');
      const notice = writer.messages.find((m) => m.kind === 'status' && String(m.text).includes('не приняла запрос'));
      assert.ok(notice, 'в чате строка о повторе на другой модели');
      assert.match(String(notice.text), /adaptive/);
      assert.ok(writer.messages.some((m) => JSON.stringify(m).includes('LIVE-REPLY')), 'ответ пришёл');
    } finally {
      delete process.env.DEVIN_REJECT_MODEL;
    }
  });
});

test('devin runtime: swe-2-high rejected with invalid_argument is not retried — the error is shown', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_REJECT_MODEL = 'swe-2-high';
    try {
      const writer = makeWriter();
      await assert.rejects(() => devinRuntime.run('Hi', {
        cwd: tempRoot,
        sessionId: 'app-model-reject-default',
        model: 'swe-2-high',
        permissionMode: 'default',
      }, writer, runtimeContext));
      assert.ok(writer.messages.some((m) => m.kind === 'error'), 'ошибка показана');
    } finally {
      delete process.env.DEVIN_REJECT_MODEL;
    }
  });
});

test('devin runtime: /model, /fusion and /adaptive inside the chat are refused without starting the agent', async () => {
  for (const forbidden of ['/model opus', '  /fusion', '/Adaptive']) {
    await withFakeDevin(async (tempRoot) => {
      const writer = makeWriter();
      await devinRuntime.run(forbidden, { cwd: tempRoot, sessionId: `app-slash-${forbidden.trim()}` }, writer, runtimeContext);
      const errors = writer.messages.filter((m) => m.kind === 'error');
      const completes = writer.messages.filter((m) => m.kind === 'complete');
      assert.equal(errors.length, 1, `${forbidden}: one error`);
      assert.match(String(errors[0].content), /Смена модели Devin командой запрещена/);
      assert.equal(completes.length, 1, `${forbidden}: exactly one complete`);
      assert.equal(existsSync(process.env.DEVIN_RPC_CAPTURE), false, `${forbidden}: the agent must not have been started`);
    });
  }
});

test('devin runtime: an empty model is replaced by swe-2-high, not left to the agent config', async () => {
  await withFakeDevin(async (tempRoot) => {
    const writer = makeWriter();
    await devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-nomodel-1', permissionMode: 'default' }, writer, runtimeContext);
    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    assert.deepEqual(capture.args, ['acp', '--model', 'swe-2-high']);
  });
});

test('devin runtime: abort kills the ACP process and ends the run once', async () => {
  await withFakeDevin(async (tempRoot) => {
    process.env.DEVIN_HANG = '1';
    const writer = makeWriter();
    const runPromise = devinRuntime.run('Hi', { cwd: tempRoot, sessionId: 'app-abort-1' }, writer, runtimeContext);

    // Wait until session/new has been answered (prompt is in flight, hung).
    for (let i = 0; i < 100; i += 1) {
      if (writer.sessionId === 'devin-sess-1') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(writer.sessionId, 'devin-sess-1');

    assert.equal(devinRuntime.abort('app-abort-1'), true);
    await runPromise;

    const completes = writer.messages.filter((m) => m.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].aborted, true);

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    assert.ok(capture.calls.some((c) => c.method === 'session/cancel'), 'session/cancel sent');

    // Second abort on a finished run is a no-op, not a phantom kill.
    assert.equal(devinRuntime.abort('app-abort-1'), false);
  });
});

test('mapPermissionModeToDevinMode maps UI modes onto ACP modes', () => {
  assert.equal(mapPermissionModeToDevinMode('bypassPermissions'), 'bypass');
  assert.equal(mapPermissionModeToDevinMode('acceptEdits'), 'accept-edits');
  assert.equal(mapPermissionModeToDevinMode('plan'), 'plan');
  assert.equal(mapPermissionModeToDevinMode('auto'), 'smart');
  assert.equal(mapPermissionModeToDevinMode('default'), undefined);
  assert.equal(mapPermissionModeToDevinMode(undefined), undefined);
});

test('devin sessions normalizeMessage: ACP updates → NormalizedMessage', () => {
  const chunk = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    's1',
  );
  assert.equal(chunk[0].kind, 'stream_delta');
  assert.equal(chunk[0].content, 'hello');
  assert.equal(chunk[0].provider, 'devin');

  const thought = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
    's1',
  );
  assert.equal(thought[0].kind, 'thinking_delta');

  const tool = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Run command', kind: 'execute', rawInput: { command: 'ls' } },
    's1',
  );
  // tool_call приходит парой: сначала stream_end закрывает открытый живой блок,
  // потом сам tool_use — иначе стриминг сливается с вызовом инструмента.
  assert.equal(tool[0].kind, 'stream_end');
  assert.equal(tool[1].kind, 'tool_use');
  assert.equal(tool[1].toolId, 'tc1');

  const toolDone = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] },
    's1',
  );
  // tool_call_update text lives in content[].content.text in Devin's shape
  assert.equal(toolDone[0].kind, 'tool_result');
  assert.equal(toolDone[0].toolId, 'tc1');

  const echo = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'user echo' } },
    's1',
  );
  assert.equal(echo.length, 0);

  const noise = sessionsProvider.normalizeMessage(
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
    's1',
  );
  assert.equal(noise.length, 0);
});

test('devin runtime: permission request reaches the gateway, allow → allow_once', async () => {
  await withFakeDevin(async () => {
    process.env.DEVIN_PERMISSION_TEST = '1';
    const writer = makeWriter();
    const runPromise = devinRuntime.run('Hi', { cwd: '/tmp', sessionId: 'app-perm-1' }, writer, runtimeContext);

    const request = await waitFor(
      () => writer.messages.find((m) => m.kind === 'permission_request'),
      5000,
      'permission_request event',
    );
    assert.equal(request.provider, 'devin');
    assert.equal(request.sessionId, 'app-perm-1');
    assert.ok(request.requestId.startsWith('devin-perm-'));

    const pending = devinRuntime.permissions.listPending('app-perm-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].requestId, request.requestId);
    assert.equal(pending[0].toolName, 'rm');
    assert.equal(pending[0].input.command, 'rm -rf /tmp/x');
    assert.equal(pending[0].sessionId, 'app-perm-1');
    assert.ok(Array.isArray(pending[0].context.options));

    // «Allow once» → allow_once (не always).
    devinRuntime.permissions.resolve(request.requestId, { allow: true });
    await runPromise;

    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const answer = capture.calls.find((c) => c.answer?.id === 900);
    assert.ok(answer, 'agent got the permission response');
    assert.equal(answer.answer.result.outcome.outcome, 'selected');
    assert.equal(answer.answer.result.outcome.optionId, 'o-once');

    // Ход после ответа дошёл до конца.
    assert.equal(devinRuntime.permissions.listPending('app-perm-1').length, 0);
    assert.ok(writer.messages.some((m) => m.content === 'AFTER-PERMISSION'));
    assert.equal(writer.messages.filter((m) => m.kind === 'complete').length, 1);
  });
});

test('devin runtime: deny → reject_once; remember → allow_always', async () => {
  await withFakeDevin(async () => {
    process.env.DEVIN_PERMISSION_TEST = '1';
    const writer = makeWriter();
    const runPromise = devinRuntime.run('Hi', { cwd: '/tmp', sessionId: 'app-perm-2' }, writer, runtimeContext);
    const request = await waitFor(
      () => writer.messages.find((m) => m.kind === 'permission_request'),
      5000,
      'permission_request event',
    );

    devinRuntime.permissions.resolve(request.requestId, { allow: false, message: 'no' });
    await runPromise;
    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    assert.equal(capture.calls.find((c) => c.answer?.id === 900)?.answer.result.outcome.optionId, 'o-reject');
  });

  await withFakeDevin(async () => {
    process.env.DEVIN_PERMISSION_TEST = '1';
    const writer = makeWriter();
    const runPromise = devinRuntime.run('Hi', { cwd: '/tmp', sessionId: 'app-perm-3' }, writer, runtimeContext);
    const request = await waitFor(
      () => writer.messages.find((m) => m.kind === 'permission_request'),
      5000,
      'permission_request event',
    );

    devinRuntime.permissions.resolve(request.requestId, { allow: true, rememberEntry: 'Shell' });
    await runPromise;
    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    assert.equal(capture.calls.find((c) => c.answer?.id === 900)?.answer.result.outcome.optionId, 'o-always');
  });
});

test('devin runtime: bypass auto-allows without touching the gateway', async () => {
  await withFakeDevin(async () => {
    process.env.DEVIN_PERMISSION_TEST = '1';
    const writer = makeWriter();
    await devinRuntime.run('Hi', {
      cwd: '/tmp',
      sessionId: 'app-perm-4',
      permissionMode: 'bypassPermissions',
    }, writer, runtimeContext);

    assert.ok(!writer.messages.some((m) => m.kind === 'permission_request'), 'no UI request under bypass');
    const capture = JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8'));
    const answer = capture.calls.find((c) => c.answer?.id === 900);
    assert.equal(answer?.answer.result.outcome.optionId, 'o-once', 'first allow_* picked');
  });
});

test('devin runtime: structured prompt answer is not marked incomplete', async () => {
  await withFakeDevin(async () => {
    process.env.DEVIN_INCOMPLETE = 'structured_answer';
    const writer = makeWriter();
    await devinRuntime.run('Сделай промпт для поиска паст', { cwd: '/tmp', sessionId: 'app-struct-1' }, writer, runtimeContext);

    const completes = writer.messages.filter((m) => m.kind === 'complete');
    assert.equal(completes.length, 1, 'exactly one complete');
    assert.equal(completes[0].exitCode, 0, 'structured answer completes successfully');
    assert.ok(!writer.messages.some((m) => m.kind === 'error'), 'no error for structured answer');
  });
});

test('devin runtime: completeness classifier regression', async () => {
  const { isIncompleteDevinResponse } = await import('@/shared/utils.js');

  // Оригинальный случай: только «Как я понял задачу» + обещание.
  assert.equal(isIncompleteDevinResponse('## Как я понял задачу\n\nСейчас проверю данные.', false), true);
  assert.equal(isIncompleteDevinResponse('Сейчас поищу информацию и вернусь.', false), true);
  assert.equal(isIncompleteDevinResponse('Сейчас поищу информацию и вернусь с результатами.', false), true);
  assert.equal(isIncompleteDevinResponse('Сейчас проверю данные.', false), true);
  assert.equal(isIncompleteDevinResponse('Ещё не готово, продолжаю работу.', false), true);

  // Статус в начале, но результат ниже.
  assert.equal(isIncompleteDevinResponse('Сейчас проверю данные.\n\n## Ответ\n\nПроверка завершена.', false), false);
  assert.equal(isIncompleteDevinResponse('Сейчас проверю данные\n\n## Ответ\n\nГотово', false), false);

  // Результирующие заголовки и структура должны считаться успехом.
  assert.equal(isIncompleteDevinResponse('## Возможные улучшения\n- пункт 1\n- пункт 2', false), false);
  assert.equal(isIncompleteDevinResponse('## Версия «Максимум»\nТекст.', false), false);
  assert.equal(isIncompleteDevinResponse('## Готовый промпт\n```text\nпромпт\n```', false), false);
  assert.equal(isIncompleteDevinResponse('## Сравнение\n| a | b |\n|---|---|', false), false);
  assert.equal(isIncompleteDevinResponse('1. один\n2. два\n3. три', false), false);

  // Инструмент без последующего текста — не завершение.
  assert.equal(isIncompleteDevinResponse('Проверяю данные.', true, ''), true);
  assert.equal(isIncompleteDevinResponse('Проверяю данные.', true, 'Вот ответ.'), false);

  // Боевые обрывы 22.10 (twilight-ursinia): структура есть, но хвост объявляет
  // свою работу или просит разрешения — такой финал недоделан.
  assert.equal(isIncompleteDevinResponse(
    'Обновил `agent.md`: описал изменения, отметил необходимость повторных тестов. `git diff --check` — без ошибок.\n\nДальше: дожму и закоммичу правку, затем разбор intake.',
    true,
    'Обновил `agent.md`: описал изменения, отметил необходимость повторных тестов. `git diff --check` — без ошибок.\n\nДальше: дожму и закоммичу правку, затем разбор intake.',
  ), true);
  assert.equal(isIncompleteDevinResponse(
    'Где сейчас работа:\n- Ветка закоммичена.\n- Правка в дереве.\n- Риск найден.\n- Автоотказ не подключён.\n- На проде не изменено.\n\nДальше: дожму и закоммичу правку.',
    false,
  ), true);
  assert.equal(isIncompleteDevinResponse('Состояние не изменилось. Ближайшее действие — перепрогнать selftest. Продолжаю?', false), true);
  assert.equal(isIncompleteDevinResponse('## Ответ\n\nСделано почти всё. Осталось: закоммитить checkpoint и прогнать selftest.', false), true);

  // Легальные финалы: шаги человеку / внешнему процессу — завершение, а не обрыв.
  assert.equal(isIncompleteDevinResponse('## Ответ\n\n🟡 Готово частично.\n\n## Дальше\nНужно от вас: перезапуск службы — требует sudo.', false), false);
  assert.equal(isIncompleteDevinResponse('## Дальше\nПо плану: сторож пришлёт результат проверки через 30 минут.', false), false);
  assert.equal(isIncompleteDevinResponse('## Готово\nPR подготовлен к ревью, в прод не внедрено — решение за человеком, пришлите вердикт.', false), false);

  // Реальный обрывный ответ из сессии sable-fragment (17.10.26) должен был
  // считаться полноценным, а не ошибкой.
  try {
    const realText = await readFile('/tmp/sable-fragment-node41.txt', 'utf8');
    assert.equal(isIncompleteDevinResponse(realText, false), false, 'real prompt answer should be complete');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
});

test('devin supervisor: ход переживает разрыв клиента, запрос разрешения доезжает до нового', async () => {
  await withFakeDevin(async () => {
    // session/prompt висит, пока не ответят на session/request_permission.
    process.env.DEVIN_PERMISSION_TEST = '1';

    const { spawnSupervisedDevin, connectSupervisedDevin } = await import('./devin-acp-client.js');
    const child = await spawnSupervisedDevin({
      command: process.env.DEVIN_CLI_PATH,
      args: ['acp'],
      cwd: '/tmp',
      env: process.env,
    });
    assert.ok(child.pid > 0, 'devin pid via supervisor');
    assert.ok(child.socketPath.endsWith('.sock'));

    const agentLines = [];
    child.stdout.on('data', (chunk) => agentLines.push(String(chunk)));

    const captureCalls = async () => {
      try {
        return JSON.parse(await readFile(process.env.DEVIN_RPC_CAPTURE, 'utf8')).calls;
      } catch {
        return [];
      }
    };

    // «Сервер»: рукопожатие + prompt → агент спрашивает разрешение и ждёт.
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'devin-sess-1', prompt: [] } }) + '\n');
    await waitFor(async () => (await captureCalls()).some((c) => c.method === 'session/prompt'), 5000, 'prompt reached agent');
    await waitFor(() => agentLines.join('').includes('session/request_permission'), 5000, 'permission request forwarded');

    // «Смерть сервера»: сокет порвался — агент при этом должен жить,
    // потому что prompt ещё не отвечён.
    child.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    try { process.kill(child.pid, 0); } catch { assert.fail('devin died on client disconnect'); }

    // «Новый сервер»: переподключение — hello + повтор неотвеченного запроса.
    const lines = [];
    let turnEnded = false;
    const link = await connectSupervisedDevin({
      socketPath: child.socketPath,
      onLine: (line) => lines.push(line),
      onTurnEnd: () => { turnEnded = true; },
    });
    assert.equal(link.devinPid, child.pid);
    assert.equal(link.promptInFlight, true, 'prompt still in flight');
    await waitFor(() => lines.some((l) => l.includes('session/request_permission')), 5000, 'pending request replayed');

    // Отвечаем разрешением — агент завершает prompt.
    link.writeLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 900,
      result: { outcome: { outcome: 'selected', optionId: 'o-once' } },
    }));
    await waitFor(() => turnEnded, 5000, 'turn_end after answer');
    const calls = await captureCalls();
    const answer = calls.find((c) => c.answer?.id === 900);
    assert.equal(answer?.answer.result.outcome.optionId, 'o-once');

    link.close();
    // Ответный prompt закрыт, клиент отключён — супервизор добирает агента.
    await waitFor(() => {
      try { process.kill(child.pid, 0); return false; } catch { return true; }
    }, 5000, 'agent reaped after disconnect without prompt');
  });
});
