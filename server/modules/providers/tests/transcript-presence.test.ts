import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hasTranscriptOnDisk } from '@/modules/providers/list/claude/transcript-presence.js';

const ID = '128968a5-d642-4295-922a-f16f5818c312';

test('transcript-presence: finds a transcript in any project folder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcript-presence-'));
  try {
    await mkdir(path.join(dir, 'projects', '-home-a'), { recursive: true });
    await mkdir(path.join(dir, 'projects', '-home-b'), { recursive: true });
    // Номер записан, файла нет — первый ход оборвался до записи.
    assert.equal(await hasTranscriptOnDisk(dir, ID), false);
    await writeFile(path.join(dir, 'projects', '-home-b', `${ID}.jsonl`), '{}\n');
    assert.equal(await hasTranscriptOnDisk(dir, ID), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transcript-presence: when unsure, keeps the normal resume path', async () => {
  assert.equal(await hasTranscriptOnDisk('', ID), true);
  assert.equal(await hasTranscriptOnDisk(path.join(os.tmpdir(), 'no-such-account-dir-xyz'), ID), true);
  assert.equal(await hasTranscriptOnDisk(os.tmpdir(), 'not-a-session-id'), true);
});
