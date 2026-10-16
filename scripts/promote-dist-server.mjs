#!/usr/bin/env node
// The server build stages into dist-server.next and this script promotes it
// into place. The live dist-server must never be deleted before the new build
// is complete: an interrupted build would otherwise leave the installation
// without a server entrypoint, crash-looping on MODULE_NOT_FOUND at every
// start until someone rebuilds it by hand.
import fs from 'node:fs';

const NEXT = 'dist-server.next';
const LIVE = 'dist-server';
const OLD = 'dist-server.old';
const ENTRY = 'server/index.js';

const mode = process.argv[2] ?? 'promote';

if (mode === 'recover') {
  // Ran before every server start: if a promotion was interrupted between the
  // two renames, put the previous build back so the server can boot.
  if (!fs.existsSync(`${LIVE}/${ENTRY}`) && fs.existsSync(`${OLD}/${ENTRY}`)) {
    console.error('promote-dist-server: restoring previous dist-server after an interrupted promotion.');
    fs.rmSync(LIVE, { recursive: true, force: true });
    fs.renameSync(OLD, LIVE);
  }
  process.exit(0);
}

if (mode !== 'promote') {
  console.error(`promote-dist-server: unknown mode "${mode}" (expected "promote" or "recover").`);
  process.exit(64);
}

if (!fs.existsSync(`${NEXT}/${ENTRY}`)) {
  console.error(`promote-dist-server: ${NEXT}/${ENTRY} is missing; leaving the current ${LIVE} untouched.`);
  process.exit(1);
}

// ── Метка сборки и защита от гонки выкаток ────────────────────────────────
// Параллельные чаты собирают dist-server из разных worktree/веток и могут
// молча выкатить СТАРУЮ сборку поверх новой — чужая правка пропадает без
// следа (инцидент 16.10: антишторм-кулдаун жил в проде 8 минут).
// Метка: время артефакта (mtime входа) + git-контекст. Правило: сборка,
// чей входной файл старше уже выкаченного, — это протухший артефакт
// (очередь, реплей, чужой worktree) и выкатывать её нельзя.
import { execSync } from 'node:child_process';

const STAMP = '.build-stamp.json';

const readStamp = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(`${dir}/${STAMP}`, 'utf8'));
  } catch {
    return null;
  }
};

const git = (args) => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
};

const entryMtime = fs.statSync(`${NEXT}/${ENTRY}`).mtime.toISOString();
const liveStamp = readStamp(LIVE);

if (liveStamp?.builtAt && entryMtime < liveStamp.builtAt && !process.env.PROMOTE_FORCE) {
  console.error(
    `promote-dist-server: REFUSED — candidate artifact (${entryMtime}) is older than the deployed build ` +
    `(${liveStamp.builtAt}, head=${liveStamp.gitHead ?? 'unknown'}). ` +
    `A stale build would silently overwrite a newer deployment; rebuild and promote again, ` +
    `or set PROMOTE_FORCE=1 if this ordering is intended.`
  );
  process.exit(65);
}

const stamp = {
  builtAt: entryMtime,
  promotedAt: new Date().toISOString(),
  gitHead: git('rev-parse --short HEAD'),
  gitDirty: (git('status --porcelain') ?? '').split('\n').filter(Boolean).length,
  worktree: process.cwd(),
  builderPid: process.ppid,
};
fs.writeFileSync(`${NEXT}/${STAMP}`, JSON.stringify(stamp, null, 2) + '\n');

if (liveStamp && liveStamp.gitHead !== stamp.gitHead) {
  console.error(
    `promote-dist-server: NOTE — deployed head ${liveStamp.gitHead ?? 'none'} -> ${stamp.gitHead ?? 'unknown'} ` +
    `(dirty files: ${stamp.gitDirty})`
  );
}

fs.rmSync(OLD, { recursive: true, force: true });
if (fs.existsSync(LIVE)) {
  fs.renameSync(LIVE, OLD);
}
try {
  fs.renameSync(NEXT, LIVE);
} catch (error) {
  // Put the previous build back before failing so the installation still boots.
  if (fs.existsSync(OLD) && !fs.existsSync(LIVE)) {
    fs.renameSync(OLD, LIVE);
  }
  throw error;
}
fs.rmSync(OLD, { recursive: true, force: true });
