import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-context-window-'));
process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
process.env.CLAUDE_CONFIG_DIR = tempDirectory;
delete process.env.CONTEXT_WINDOW;

const {
  contextWindowFromModelMarker,
  pickContextWindowFromModelUsage,
  rememberContextWindow,
  resolveClaudeContextWindow,
} = await import('@/modules/providers/services/claude-context-window.js');

test.after(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

test('пометка размера в имени модели: [1m], (200k); без пометки — нет числа', () => {
  assert.equal(contextWindowFromModelMarker('sonnet[1m]'), 1_000_000);
  assert.equal(contextWindowFromModelMarker('claude-opus-4-8[1m]'), 1_000_000);
  assert.equal(contextWindowFromModelMarker('model (200k)'), 200_000);
  assert.equal(contextWindowFromModelMarker('claude-opus-5-5'), null);
  assert.equal(contextWindowFromModelMarker(null), null);
});

test('окно берётся у модели, что вела разговор, а не у служебной', () => {
  // Настоящий итог SDK 23.09.26: служебный Sonnet на 200 000 рядом с Opus на 1 000 000.
  const modelUsage = {
    'claude-sonnet-5': { contextWindow: 200_000 },
    'claude-opus-4-8[1m]': { contextWindow: 1_000_000 },
  };
  assert.deepEqual(pickContextWindowFromModelUsage(modelUsage, 'claude-opus-4-8'), {
    model: 'claude-opus-4-8[1m]',
    contextWindow: 1_000_000,
  });
  assert.equal(pickContextWindowFromModelUsage(modelUsage, 'claude-sonnet-5')?.contextWindow, 200_000);
  assert.equal(pickContextWindowFromModelUsage(modelUsage, null)?.contextWindow, 1_000_000);
  assert.equal(pickContextWindowFromModelUsage({}, 'x'), null);
});

test('порядок источников: сообщённое Claude → пометка модели → настройки для default → виденный объём → 200 000', async () => {
  assert.equal(resolveClaudeContextWindow({ sessionIds: ['s-none'], sessionModel: 'sonnet' }), 200_000);
  assert.equal(resolveClaudeContextWindow({ sessionIds: ['s-none'], sessionModel: 'sonnet', maxObservedContext: 350_000 }), 1_000_000);
  assert.equal(resolveClaudeContextWindow({ sessionIds: ['s-none'], sessionModel: 'sonnet[1m]' }), 1_000_000);

  await writeFile(path.join(tempDirectory, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }));
  assert.equal(resolveClaudeContextWindow({ sessionIds: ['s-default'], sessionModel: 'default' }), 1_000_000);

  rememberContextWindow(['s-told', null], 200_000, 'claude-sonnet-5');
  assert.equal(resolveClaudeContextWindow({ sessionIds: ['other', 's-told'], sessionModel: 'sonnet[1m]' }), 200_000);
});
