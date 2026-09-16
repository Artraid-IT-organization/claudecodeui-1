import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveClaudeCodeExecutablePath,
  type ResolveClaudeCodeExecutablePathDependencies,
  waitForClaudeCodeExecutable,
} from '@/shared/claude-cli-path.js';

test('resolveClaudeCodeExecutablePath resolves the npm Claude wrapper to its native exe on Windows', () => {
  const wrapperDir = 'C:\\nvm4w\\nodejs';
  const nativePath = `${wrapperDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const execFileSync =
    (() => `${wrapperDir}\\claude\r\n${wrapperDir}\\claude.cmd\r\n`) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];
  const readFileSync = (() => '') as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath keeps an explicit JavaScript launcher path unchanged', () => {
  const scriptPath = 'C:\\tools\\claude.js';

  const resolved = resolveClaudeCodeExecutablePath(scriptPath, {
    platform: 'win32',
  });

  assert.equal(resolved, scriptPath);
});

test('resolveClaudeCodeExecutablePath can parse a wrapper file path containing letters r and n before claude.exe', () => {
  const wrapperPath = 'C:\\tools\\claude';
  const nativePath = 'C:\\tools\\custom\\bin\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const readFileSync = (() => `exec "$basedir/custom/bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"`) as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath(wrapperPath, {
    platform: 'win32',
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath falls back to the configured command when PATH lookup fails', () => {
  const execFileSync = (() => {
    throw new Error('not found');
  }) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
  });

  assert.equal(resolved, 'claude');
});

const fakeStat = (mtimeMs: number) => ({ mtimeMs, mode: 0o755, isFile: () => true });

test('waitForClaudeCodeExecutable waits out a reinstall instead of falling back to an older claude on PATH', async () => {
  let clock = 1_000_000;
  const reinstalledAt = clock + 3_000;
  const resolved = await waitForClaudeCodeExecutable(undefined, {
    platform: 'linux',
    execPath: '/opt/node/bin/node',
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    readdirSync: () => ['.claude-code-Ab12Cd'],
    statSync: (target) => (target === '/opt/node/bin/claude' && clock >= reinstalledAt ? fakeStat(reinstalledAt) : null),
  });

  assert.equal(resolved, '/opt/node/bin/claude');
  assert.ok(clock >= reinstalledAt + 5_000, 'waited for the fresh binary to settle');
});

test('waitForClaudeCodeExecutable keeps PATH lookup when this Node has no global Claude install', async () => {
  const resolved = await waitForClaudeCodeExecutable(undefined, {
    platform: 'linux',
    execPath: '/usr/bin/node',
    readdirSync: () => [],
    statSync: () => null,
  });

  assert.equal(resolved, 'claude');
});

test('waitForClaudeCodeExecutable respects an explicit CLAUDE_CLI_PATH', async () => {
  const resolved = await waitForClaudeCodeExecutable('/custom/claude', { platform: 'linux' });
  assert.equal(resolved, '/custom/claude');
});

test('waitForClaudeCodeExecutable gives up after the timeout and uses PATH lookup', async () => {
  let clock = 0;
  const resolved = await waitForClaudeCodeExecutable(undefined, {
    platform: 'linux',
    execPath: '/opt/node/bin/node',
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    readdirSync: () => ['claude-code'],
    statSync: () => null,
    timeoutMs: 10_000,
  });

  assert.equal(resolved, 'claude');

  // A broken install must not stall every following turn for the full timeout.
  const before = clock;
  const again = await waitForClaudeCodeExecutable(undefined, {
    platform: 'linux',
    execPath: '/opt/node/bin/node',
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    readdirSync: () => ['claude-code'],
    statSync: () => null,
    timeoutMs: 10_000,
  });
  assert.equal(again, 'claude');
  assert.equal(clock, before, 'no waiting during the cooldown');
});
