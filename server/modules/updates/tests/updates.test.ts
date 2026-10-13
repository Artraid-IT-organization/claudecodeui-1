import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  dismissUpdate,
  getUpdateStatus,
  openDiscussChat,
  restoreDismissedUpdate,
  startApply,
} from '@/modules/updates/updates.service.js';
import { AppError } from '@/shared/utils.js';

const PENDING: {
  id: string;
  label: string;
  remote: string;
  base: string;
  commits: Array<{ sha: string; subject: string; date: string; author: string }>;
  filesChanged: number;
  diffStat: string;
  conflict: { kind: string; items: Array<{ path: string; note: string }> } | null;
  checkedAt: string;
} = {
  id: 'abc123def456',
  label: 'Обновление с другого сервера',
  remote: 'egor/main',
  base: '000000000001',
  commits: [
    { sha: 'abc123d', subject: 'feat: новая кнопка', date: '2026-10-12T10:00:00Z', author: 'claude' },
  ],
  filesChanged: 3,
  diffStat: '3 files changed',
  conflict: null,
  checkedAt: '2026-10-12T10:00:00Z',
};

let dir = '';
test.beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ccui-updates-'));
  process.env.CCUI_UPDATE_STATE_DIR = dir;
  process.env.CCUI_UPDATE_APPLY_CMD = 'true';
});
test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CCUI_UPDATE_STATE_DIR;
  delete process.env.CCUI_UPDATE_APPLY_CMD;
});

function writePending(over: Partial<typeof PENDING> = {}) {
  writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ ...PENDING, ...over }));
}

test('нет pending.json — пустой статус, плашка не рисуется', () => {
  const status = getUpdateStatus();
  assert.equal(status.pending, null);
  assert.equal(status.dismissed, null);
  assert.equal(status.configured, true);
});

test('без apply-команды экземпляр «не настроен»', () => {
  delete process.env.CCUI_UPDATE_APPLY_CMD;
  writePending();
  assert.equal(getUpdateStatus().configured, false);
});

test('pending виден, «Отложить» скрывает его в dismissed', () => {
  writePending();
  assert.equal(getUpdateStatus().pending?.id, PENDING.id);
  dismissUpdate(PENDING.id);
  const status = getUpdateStatus();
  assert.equal(status.pending, null);
  assert.equal(status.dismissed?.id, PENDING.id);
  restoreDismissedUpdate(PENDING.id);
  assert.equal(getUpdateStatus().pending?.id, PENDING.id);
});

test('apply: нет такого пула — отказ, не ставим не то', () => {
  writePending();
  assert.throws(() => startApply('другой-id', false), AppError);
});

test('apply: конфликтный пул без force — отказ', () => {
  writePending({ conflict: { kind: 'patches', items: [{ path: '0001.patch', note: 'не ложится' }] } });
  assert.throws(() => startApply(PENDING.id, false), AppError);
});

test('apply: чистый пул стартует и пишет apply.json running', () => {
  writePending();
  const result = startApply(PENDING.id, false);
  assert.deepEqual(result, { started: true });
  const apply = JSON.parse(readFileSync(path.join(dir, 'apply.json'), 'utf8'));
  assert.equal(apply.state, 'running');
  assert.equal(apply.id, PENDING.id);
});

test('apply: повторный запуск при идущей установке — отказ', () => {
  writePending();
  writeFileSync(path.join(dir, 'apply.json'), JSON.stringify({ id: PENDING.id, state: 'running', startedTs: Date.now() }));
  assert.throws(() => startApply(PENDING.id, false), AppError);
});

test('discuss без пула — отказ, чат не создаётся', async () => {
  await assert.rejects(() => openDiscussChat('1'), AppError);
});
