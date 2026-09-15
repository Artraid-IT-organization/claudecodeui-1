#!/usr/bin/env node
// Поддельный CLI Claude для теста конца хода: на первое сообщение отвечает
// ходом «ONE», а следом, как настоящий CLI с непустой очередью, берёт
// следующий ход «TWO». idle — только после второго.
// FAKE_CLAUDE_NO_IDLE=1 — idle не присылать; FAKE_CLAUDE_GAP_MS — пауза перед
// вторым ходом. Если вход закрыли до второго хода, его текст — «TWO-after-close».
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const sessionId = randomUUID();
const out = (message) => process.stdout.write(`${JSON.stringify({ uuid: randomUUID(), session_id: sessionId, ...message })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assistant = (text) => out({ type: 'assistant', parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', model: 'fake', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
const init = () => out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fake', permissionMode: 'default', apiKeySource: 'none' });
const emitStates = process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === '1';
const noIdle = process.env.FAKE_CLAUDE_NO_IDLE === '1';
const gapMs = Number(process.env.FAKE_CLAUDE_GAP_MS || 300);

let started = false;
let stdinClosed = false;
let finishWork;
const workDone = new Promise((resolve) => { finishWork = resolve; });
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_request') {
    process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })}\n`);
    return;
  }
  if (message.type !== 'user' || started) return;
  started = true;
  if (emitStates) out({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  if (process.env.FAKE_CLAUDE_SCENARIO === 'background') {
    // Ход запускает фоновую задачу; её ответ — следующий ход без idle, а за ним
    // через паузу ещё ход. Вход не должен закрыться до третьего хода.
    init();
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 1', run_in_background: true } }], usage: { input_tokens: 1, output_tokens: 1 } } });
    assistant('ONE');
    result('ONE');
    await sleep(300);
    init();
    assistant('BG-REPORT');
    result('BG-REPORT');
    await sleep(gapMs);
    init();
    assistant(stdinClosed ? 'THREE-after-close' : 'THREE');
    result('THREE');
    await sleep(200);
    process.exit(0);
  }
  init();
  assistant('ONE');
  result('ONE');
  await sleep(gapMs);
  init();
  await sleep(700);
  assistant(stdinClosed ? 'TWO-after-close' : 'TWO');
  await sleep(700);
  result('TWO');
  if (emitStates && !noIdle) out({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  finishWork();
  // Без idle сайт держит вход до потолка — выходим сами, как закончивший CLI.
  if (noIdle) { await sleep(200); process.exit(0); }
});
lines.on('close', async () => {
  // Вход закрыт: как настоящий CLI, доделываем начатое и выходим.
  stdinClosed = true;
  if (started) await workDone;
  await sleep(200);
  process.exit(0);
});
