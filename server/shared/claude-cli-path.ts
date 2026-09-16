import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CLAUDE_COMMAND = 'claude';
const CLAUDE_SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const CLAUDE_WRAPPER_SEGMENTS = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'] as const;

export type ResolveClaudeCodeExecutablePathDependencies = {
  execFileSync?: typeof execFileSync;
  existsSync?: typeof fs.existsSync;
  platform?: NodeJS.Platform;
  readFileSync?: typeof fs.readFileSync;
};

function getPathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function resolveClaudeWrapperBinary(
  wrapperPath: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string | null {
  const pathApi = getPathApi(deps.platform);
  const directCandidate = pathApi.resolve(pathApi.dirname(wrapperPath), ...CLAUDE_WRAPPER_SEGMENTS);

  if (deps.existsSync(directCandidate)) {
    return directCandidate;
  }

  let content: string;
  try {
    content = deps.readFileSync(wrapperPath, 'utf8');
  } catch {
    return null;
  }

  const matches = content.matchAll(/["']([^"'\\\r\n]*claude\.exe)["']/gi);
  for (const match of matches) {
    const rawTarget = match[1]
      .replace(/^\$basedir[\\/]/i, '')
      .replace(/^%dp0%[\\/]/i, '')
      .replace(/^%~dp0[\\/]/i, '');
    const normalizedTarget = rawTarget.replace(/[\\/]/g, pathApi.sep);
    const candidate = pathApi.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : pathApi.resolve(pathApi.dirname(wrapperPath), normalizedTarget);

    if (deps.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveWindowsClaudeExecutablePath(
  configuredPath: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string {
  const pathApi = getPathApi(deps.platform);
  const extension = pathApi.extname(configuredPath).toLowerCase();
  const explicitPath = isPathLike(configuredPath) || pathApi.isAbsolute(configuredPath);

  if (CLAUDE_SCRIPT_EXTENSIONS.has(extension)) {
    return configuredPath;
  }

  if (explicitPath && extension === '.exe') {
    return configuredPath;
  }

  if (explicitPath) {
    return resolveClaudeWrapperBinary(configuredPath, deps) ?? configuredPath;
  }

  try {
    const stdout = deps.execFileSync('where.exe', [configuredPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const candidates = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (pathApi.extname(candidate).toLowerCase() === '.exe') {
        return candidate;
      }
    }

    for (const candidate of candidates) {
      const resolved = resolveClaudeWrapperBinary(candidate, deps);
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    return configuredPath;
  }

  return configuredPath;
}

export function resolveClaudeCodeExecutablePath(
  configuredPath: string | undefined = process.env.CLAUDE_CLI_PATH,
  dependencies: ResolveClaudeCodeExecutablePathDependencies = {},
): string {
  const deps: Required<ResolveClaudeCodeExecutablePathDependencies> = {
    execFileSync: dependencies.execFileSync ?? execFileSync,
    existsSync: dependencies.existsSync ?? fs.existsSync,
    platform: dependencies.platform ?? process.platform,
    readFileSync: dependencies.readFileSync ?? fs.readFileSync,
  };

  const normalizedPath = stripWrappingQuotes(configuredPath || DEFAULT_CLAUDE_COMMAND);
  if (deps.platform !== 'win32') {
    return normalizedPath;
  }

  return resolveWindowsClaudeExecutablePath(normalizedPath, deps);
}

export type WaitForClaudeExecutableDependencies = {
  execPath?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  statSync?: (target: string) => { mtimeMs: number; mode: number; isFile(): boolean } | null;
  readdirSync?: (target: string) => string[];
  timeoutMs?: number;
  settleMs?: number;
  pollMs?: number;
};

const REINSTALL_WAIT_TIMEOUT_MS = 120_000;
const REINSTALL_SETTLE_MS = 5_000;
const REINSTALL_POLL_MS = 1_000;
// After one full timeout the install is broken rather than mid-reinstall;
// don't make every following turn wait the whole timeout again.
const REINSTALL_GIVE_UP_COOLDOWN_MS = 10 * 60_000;
let gaveUpAt: number | null = null;

/**
 * Picks the Claude CLI that was installed together with the Node running this
 * server, and waits it out if npm is reinstalling it right now.
 *
 * Why: a bare `claude` is looked up on PATH at spawn time. While
 * `npm install -g @anthropic-ai/claude-code` swaps the package, the link next
 * to Node is missing for a few seconds and the lookup silently falls through to
 * whatever older copy sits later on PATH (here /usr/local/bin had a months-old
 * build). That old build sent a history the API rejects ("text content blocks
 * must be non-empty") — and a queued message, sent the moment the previous
 * turn ends, is exactly what tends to land in that window.
 *
 * Returns the configured value unchanged when CLAUDE_CLI_PATH is set, on
 * Windows, or when this Node has no global Claude install — PATH lookup stays
 * the behaviour there.
 */
export async function waitForClaudeCodeExecutable(
  configuredPath: string | undefined = process.env.CLAUDE_CLI_PATH,
  dependencies: WaitForClaudeExecutableDependencies = {},
): Promise<string> {
  const platform = dependencies.platform ?? process.platform;
  const fallback = resolveClaudeCodeExecutablePath(configuredPath, { platform });
  if (configuredPath || platform === 'win32') {
    return fallback;
  }

  const statSync = dependencies.statSync ?? ((target: string) => {
    try {
      return fs.statSync(target);
    } catch {
      return null;
    }
  });
  const readdirSync = dependencies.readdirSync ?? ((target: string) => {
    try {
      return fs.readdirSync(target);
    } catch {
      return [];
    }
  });
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const binDir = path.dirname(dependencies.execPath ?? process.execPath);
  const candidate = path.join(binDir, DEFAULT_CLAUDE_COMMAND);
  const scopeDir = path.join(binDir, '..', 'lib', 'node_modules', '@anthropic-ai');
  // npm keeps the old tree as `.claude-code-XXXX` while it swaps packages, so
  // either name means "Claude belongs to this Node" even mid-reinstall.
  const installedHere = readdirSync(scopeDir).some(
    (entry) => entry === 'claude-code' || entry.startsWith('.claude-code-'),
  );
  if (!installedHere) {
    return fallback;
  }

  const coolingDown = gaveUpAt !== null && now() - gaveUpAt < REINSTALL_GIVE_UP_COOLDOWN_MS;
  const timeoutMs = coolingDown ? 0 : (dependencies.timeoutMs ?? REINSTALL_WAIT_TIMEOUT_MS);
  const settleMs = dependencies.settleMs ?? REINSTALL_SETTLE_MS;
  const pollMs = dependencies.pollMs ?? REINSTALL_POLL_MS;
  const startedAt = now();
  let warned = false;

  while (true) {
    const stat = statSync(candidate);
    // A binary written moments ago may still be mid-copy by the postinstall step.
    const ready = Boolean(stat && stat.isFile() && (stat.mode & 0o111) && now() - stat.mtimeMs >= settleMs);
    if (ready) {
      gaveUpAt = null;
      if (warned) {
        console.log(`[claude-cli] ${candidate} is back after ${Math.round((now() - startedAt) / 1000)}s`);
      }
      return candidate;
    }
    if (now() - startedAt >= timeoutMs) {
      if (coolingDown) {
        return fallback;
      }
      gaveUpAt = now();
      console.warn(`[claude-cli] ${candidate} still not ready after ${Math.round(timeoutMs / 1000)}s, falling back to PATH lookup`);
      return fallback;
    }
    if (!warned) {
      console.warn(`[claude-cli] ${candidate} is being reinstalled, waiting before starting the chat`);
      warned = true;
    }
    await sleep(pollMs);
  }
}
