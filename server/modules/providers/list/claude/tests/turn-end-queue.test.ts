import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Страховку укорачиваем до чтения модуля (константа читается при импорте).
process.env.CLAUDE_TURN_END_FALLBACK_MS = '800';

type RunEvent = { kind: string; text?: string; at: number };

async function runWithFakeCli(): Promise<RunEvent[]> {
  const liveDir = await mkdtemp(path.join(tmpdir(), 'turn-end-live-'));
  const configDir = await mkdtemp(path.join(tmpdir(), 'turn-end-config-'));
  process.env.CLOUDCLI_LIVE_RUNS_DIR = liveDir;
  process.env.CLAUDE_CLI_PATH = path.join(here, 'fixtures', 'fake-claude-queue.mjs');
  const runtimeModule = process.env.TURN_END_RUNTIME_MODULE || '@/modules/providers/list/claude/claude-runtime.provider.js';
  try {
    const { claudeRuntime } = await import(runtimeModule);
    const events: RunEvent[] = [];
    const writer = {
      userId: null,
      send(message: { kind: string; text?: string }) {
        events.push({ kind: message.kind, text: message.text, at: Date.now() });
      },
      setSessionId() {},
    };
    const context = {
      resolveProviderSessionId: () => null,
      getProviderModels: async () => { throw new Error('в тесте моделей нет'); },
      resolveResumeModel: async (_sessionId: string, model: string) => model,
      normalizeMessage: (message: { type: string; message?: { content?: { text?: string }[] } }) =>
        message.type === 'assistant'
          ? [{ kind: 'text', text: message.message?.content?.[0]?.text }]
          : [],
      isProviderInstalled: async () => true,
    };
    await claudeRuntime.run('проверка', { cwd: configDir, claudeConfigDir: configDir, permissionMode: 'bypassPermissions' }, writer, context);
    return events;
  } finally {
    await rm(liveDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
}

const describe = (events: RunEvent[]) => events.map((event) => event.text || event.kind).join(', ');

// 15.09.26: сайт гасил индикатор на первом `result`, хотя CLI уже брал из
// очереди следующий ход. Агент работал невидимкой, а следующее сообщение
// запускало вторую копию. «Готово» должно уходить только в конце очереди.
test('«готово» уходит после последнего хода очереди CLI, а не после первого result', async () => {
  const events = await runWithFakeCli();
  assert.deepEqual(events.filter((event) => event.kind === 'error'), [], 'запуск без ошибок');
  const two = events.findIndex((event) => event.kind === 'text' && event.text === 'TWO');
  const completes = events.map((event, index) => (event.kind === 'complete' ? index : -1)).filter((index) => index >= 0);
  assert.ok(two >= 0, `второй ход дошёл до экрана (события: ${describe(events)})`);
  assert.equal(completes.length, 1, 'ровно одно «готово»');
  assert.ok(completes[0] > two, `«готово» после второго хода (события: ${describe(events)})`);
});

// Если idle не пришёл, «готово» уходит по страховке, но вход CLI не закрывается:
// иначе работающий агент снова стал бы недосягаем для «Стопа» и новых сообщений.
test('страховка без idle не отрезает вход у CLI, который ещё работает', async () => {
  process.env.FAKE_CLAUDE_NO_IDLE = '1';
  process.env.FAKE_CLAUDE_GAP_MS = '2000';
  try {
    const events = await runWithFakeCli();
    assert.deepEqual(events.filter((event) => event.kind === 'error'), [], 'запуск без ошибок');
    assert.ok(events.some((event) => event.text === 'TWO'), `вход не закрыт до второго хода (события: ${describe(events)})`);
    assert.equal(events.filter((event) => event.kind === 'complete').length, 1, 'ровно одно «готово»');
  } finally {
    delete process.env.FAKE_CLAUDE_NO_IDLE;
    delete process.env.FAKE_CLAUDE_GAP_MS;
  }
});

// Ответ фоновой работы без idle, а следом ещё ход: страховка и тут не закрывает вход.
test('после ответа фоновой работы страховка тоже не отрезает вход', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = 'background';
  process.env.FAKE_CLAUDE_GAP_MS = '2000';
  try {
    const events = await runWithFakeCli();
    assert.deepEqual(events.filter((event) => event.kind === 'error'), [], 'запуск без ошибок');
    assert.ok(events.some((event) => event.text === 'THREE'), `вход не закрыт до третьего хода (события: ${describe(events)})`);
    assert.equal(events.filter((event) => event.kind === 'complete').length, 1, 'ровно одно «готово»');
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
    delete process.env.FAKE_CLAUDE_GAP_MS;
  }
});
