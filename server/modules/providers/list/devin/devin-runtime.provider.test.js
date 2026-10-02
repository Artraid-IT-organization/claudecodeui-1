import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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

rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method === undefined) { return; } // client answers our requests — none sent
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
      // Replayed history MUST be muted by the runtime.
      notify('session/update', { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-OLD-TEXT' } } });
      respond(msg.id, { sessionId: msg.params.sessionId });
      break;
    case 'session/set_mode':
    case 'session/set_config_option':
      respond(msg.id, {});
      break;
    case 'session/prompt': {
      if (process.env.DEVIN_HANG === '1') return; // never answer → abort test
      const sid = msg.params.sessionId;
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking hard' } } });
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LIVE-REPLY' } } });
      notify('session/update', { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 100, size: 200000 } });
      respond(msg.id, { stopReason: 'end_turn', usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 } });
      setTimeout(() => process.exit(0), 50);
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
  const shim = await createFakeDevinExecutable(tempRoot);
  process.env.DEVIN_CLI_PATH = shim;
  process.env.DEVIN_RPC_CAPTURE = path.join(tempRoot, 'rpc.json');
  try {
    await fn(tempRoot);
  } finally {
    if (previousCliPath === undefined) delete process.env.DEVIN_CLI_PATH; else process.env.DEVIN_CLI_PATH = previousCliPath;
    if (previousCapture === undefined) delete process.env.DEVIN_RPC_CAPTURE; else process.env.DEVIN_RPC_CAPTURE = previousCapture;
    if (previousHang === undefined) delete process.env.DEVIN_HANG; else process.env.DEVIN_HANG = previousHang;
    await rm(tempRoot, { recursive: true, force: true });
  }
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
    assert.deepEqual(capture.args, ['acp']);
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
  assert.equal(tool[0].kind, 'tool_use');
  assert.equal(tool[0].toolId, 'tc1');

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
