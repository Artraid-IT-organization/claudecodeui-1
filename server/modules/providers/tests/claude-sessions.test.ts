import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SESSION_ID = 'session-1';

const SKILL_BODY = [
  'Base directory for this skill: /tmp/claude/bundled-skills/2.1.220/abc123/claude-api',
  '',
  '# Building LLM-Powered Applications with Claude',
  '',
  'This skill helps you build LLM-powered applications with Claude.',
].join('\n');

test('claude: injected skill bodies are hidden even without the isMeta flag', () => {
  const provider = new ClaudeSessionsProvider();

  // The live SDK stream omits `isMeta`, so the payload has to be recognised by
  // its content or it renders as a giant user bubble mid-run.
  const live = provider.normalizeMessage(
    {
      uuid: 'u1',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(live, []);

  const persisted = provider.normalizeMessage(
    {
      uuid: 'u2',
      timestamp: '2026-07-28T10:00:00.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(persisted, []);
});

test('claude: stop hook feedback is not shown as a human message', () => {
  const provider = new ClaudeSessionsProvider();
  const text = 'Stop hook feedback:\nНе останавливайся на вопросе-разрешении.';

  const live = provider.normalizeMessage(
    { uuid: 'h1', timestamp: '2026-09-15T14:25:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } },
    SESSION_ID,
  );
  assert.deepEqual(live, []);

  const liveString = provider.normalizeMessage(
    { uuid: 'h2', timestamp: '2026-09-15T14:25:00.000Z', message: { role: 'user', content: text } },
    SESSION_ID,
  );
  assert.deepEqual(liveString, []);
});

test('claude: a subagent prompt is not shown as a human message', () => {
  const provider = new ClaudeSessionsProvider();
  const prompt = 'Только чтение, ничего не менять. Проверь ДЕЛОМ выполнимость плана.';

  const live = provider.normalizeMessage(
    { type: 'user', parent_tool_use_id: 'toolu_agent', parentToolUseId: 'toolu_agent', message: { role: 'user', content: prompt } },
    SESSION_ID,
  );
  assert.deepEqual(live, []);

  const liveArray = provider.normalizeMessage(
    { type: 'user', parent_tool_use_id: 'toolu_agent', message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    SESSION_ID,
  );
  assert.deepEqual(liveArray, []);

  const sidechain = provider.normalizeMessage(
    { uuid: 's1', isSidechain: true, message: { role: 'user', content: prompt } },
    SESSION_ID,
  );
  assert.deepEqual(sidechain, []);

  const synthetic = provider.normalizeMessage(
    { type: 'user', isSynthetic: true, message: { role: 'user', content: prompt } },
    SESSION_ID,
  );
  assert.deepEqual(synthetic, []);

  const sdkObject = { parent_tool_use_id: 'toolu_agent', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }, { type: 'text', text: prompt }] } };
  provider.normalizeMessage(sdkObject, SESSION_ID);
  assert.equal(sdkObject.message.content.length, 2);

  const subagentTool = provider.normalizeMessage(
    {
      uuid: 's2',
      parent_tool_use_id: 'toolu_agent',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'ok' }] },
    },
    SESSION_ID,
  );
  assert.equal(subagentTool.length, 1);
  assert.equal(subagentTool[0].kind, 'tool_result');

  const human = provider.normalizeMessage(
    { uuid: 'u9', message: { role: 'user', content: 'хай' } },
    SESSION_ID,
  );
  assert.equal(human.length, 1);
  assert.equal(human[0].role, 'user');
});

test('claude: the Skill tool result itself still reaches the UI', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      uuid: 'u3',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: claude-api' }],
      },
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].toolId, 'toolu_1');
});

test('claude: live thinking_delta stream events unwrap to thinking_delta messages', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      type: 'stream_event',
      session_id: SESSION_ID,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me check the ', estimated_tokens: 4 },
      },
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'thinking_delta');
  assert.equal(messages[0].content, 'Let me check the ');
});

test('claude: live text_delta stream events still unwrap to stream_delta messages', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      type: 'stream_event',
      session_id: SESSION_ID,
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Sure, ' },
      },
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].content, 'Sure, ');
});

test('claude: content_block_stop stream events unwrap to a generic stream_end', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    { type: 'stream_event', session_id: SESSION_ID, event: { type: 'content_block_stop', index: 0 } },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_end');
});

test('claude: other stream_event subtypes produce no live message', () => {
  const provider = new ClaudeSessionsProvider();

  const messageStart = provider.normalizeMessage(
    { type: 'stream_event', session_id: SESSION_ID, event: { type: 'message_start' } },
    SESSION_ID,
  );
  const blockStart = provider.normalizeMessage(
    {
      type: 'stream_event',
      session_id: SESSION_ID,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    },
    SESSION_ID,
  );
  const inputJsonDelta = provider.normalizeMessage(
    {
      type: 'stream_event',
      session_id: SESSION_ID,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a"' } },
    },
    SESSION_ID,
  );

  assert.deepEqual(messageStart, []);
  assert.deepEqual(blockStart, []);
  assert.deepEqual(inputJsonDelta, []);
});

test('claude: начало блока размышления сразу даёт сигнал «думает» (пустой thinking_delta)', () => {
  const provider = new ClaudeSessionsProvider();

  const thinkingStart = provider.normalizeMessage(
    {
      type: 'stream_event',
      session_id: SESSION_ID,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    },
    SESSION_ID,
  );

  assert.equal(thinkingStart.length, 1);
  assert.equal(thinkingStart[0].kind, 'thinking_delta');
  assert.equal(thinkingStart[0].content, '');
});

test('claude: готовность агента (system init) даёт этап «модель получила запрос»', () => {
  const provider = new ClaudeSessionsProvider();
  const result = provider.normalizeMessage({ type: 'system', subtype: 'init', session_id: SESSION_ID }, SESSION_ID);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'run_phase');
  assert.equal(result[0].text, 'requesting');
});

