import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveScopedWorkingDirectory } from '@/shared/utils.js';

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-wd-'));
  const scope = path.join(root, 'workspace');
  fs.mkdirSync(path.join(scope, 'work'), { recursive: true });
  return { root, scope, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('без зоны (владелец/одиночная площадка) — путь проходит как был', () => {
  assert.equal(resolveScopedWorkingDirectory('/home/user/proj', null), '/home/user/proj');
  assert.equal(resolveScopedWorkingDirectory('  /tmp/x  ', undefined), '/tmp/x');
  assert.equal(resolveScopedWorkingDirectory(undefined, null), undefined);
  assert.equal(resolveScopedWorkingDirectory('', null), undefined);
});

test('путь внутри зоны и существующий — возвращается он', () => {
  const { scope, cleanup } = makeSandbox();
  try {
    const inside = path.join(scope, 'work');
    assert.equal(resolveScopedWorkingDirectory(inside, scope), inside);
    assert.equal(resolveScopedWorkingDirectory(scope, scope), scope);
  } finally {
    cleanup();
  }
});

test('путь вне зоны — приземляется в корень зоны', () => {
  const { scope, cleanup } = makeSandbox();
  try {
    assert.equal(resolveScopedWorkingDirectory('/tmp/igor-e2e', scope), scope);
    assert.equal(resolveScopedWorkingDirectory('/home/clwduser1', scope), scope);
    assert.equal(resolveScopedWorkingDirectory(undefined, scope), scope);
  } finally {
    cleanup();
  }
});

test('путь внутри зоны, но несуществующий — корень зоны, не ENOENT при spawn', () => {
  const { scope, cleanup } = makeSandbox();
  try {
    const ghost = path.join(scope, 'deleted-project');
    assert.equal(resolveScopedWorkingDirectory(ghost, scope), scope);
  } finally {
    cleanup();
  }
});

test('симлинк внутри зоны, ведущий наружу, — в зоне (комнаты team-access)', () => {
  const { root, scope, cleanup } = makeSandbox();
  try {
    const outside = path.join(root, 'outside-room');
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(scope, 'work-link');
    fs.symlinkSync(outside, link);
    assert.equal(resolveScopedWorkingDirectory(link, scope), link);
  } finally {
    cleanup();
  }
});

test('отсутствующий корень зоны создаётся', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-wd-missing-'));
  try {
    const scope = path.join(root, 'webuser-1', 'workspace');
    assert.equal(resolveScopedWorkingDirectory('/etc', scope), scope);
    assert.ok(fs.statSync(scope).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
