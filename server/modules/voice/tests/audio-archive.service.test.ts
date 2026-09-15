import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAudioArchiveService } from '../audio-archive.service.js';

type TelegramCall = { url: string; form: FormData };

async function makeArchive(overrides: Partial<Parameters<typeof createAudioArchiveService>[0]> = {}) {
  const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-archive-test-'));
  const calls: TelegramCall[] = [];
  const warnings: string[] = [];
  const service = createAudioArchiveService({
    archiveDir,
    retentionDays: 14,
    botToken: 'token',
    chatId: '-100500',
    fetchTelegram: (async (url: string, init?: RequestInit) => {
      calls.push({ url, form: init?.body as FormData });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch,
    convertToVoice: async (_input, output) => {
      await fs.writeFile(output, Buffer.from('OggS-fake'));
    },
    isArchivableRequest: () => true,
    log: { warn: (message: string) => warnings.push(message), info: () => undefined },
    now: () => new Date('2026-09-15T13:05:03Z'),
    ...overrides,
  });
  return { service, archiveDir, calls, warnings };
}

const audio = { bytes: Buffer.from('webm-bytes'), mimeType: 'audio/webm;codecs=opus', fileName: 'recording.webm' };

test('keeps the recording on disk under a Moscow-time name before transcription', async () => {
  const { service, archiveDir } = await makeArchive();

  const kept = await service.keep(audio);

  assert.ok(kept);
  assert.match(path.basename(kept.audioPath), /^2026-09-15_16-05-03_[0-9a-f]{6}\.webm$/);
  assert.equal(path.dirname(kept.audioPath), archiveDir);
  assert.deepEqual(await fs.readFile(kept.audioPath), audio.bytes);
});

test('uses m4a for iPhone mp4 recordings', async () => {
  const { service } = await makeArchive();

  const kept = await service.keep({ ...audio, mimeType: 'audio/mp4', fileName: 'recording.m4a' });

  assert.ok(kept?.audioPath.endsWith('.m4a'));
});

test('publish saves the transcript and posts a voice message with it as the caption', async () => {
  const { service, calls } = await makeArchive();
  const kept = await service.keep(audio);

  await service.publish(kept, { text: 'Купить молоко' });

  assert.equal(await fs.readFile(kept!.audioPath.replace('.webm', '.txt'), 'utf8'), 'Купить молоко\n');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/bottoken\/sendVoice$/);
  assert.equal(calls[0].form.get('chat_id'), '-100500');
  assert.equal(calls[0].form.get('caption'), '🎙 Claude UI · 15.09.2026 16:05\nКупить молоко');
  assert.ok(calls[0].form.get('voice') instanceof Blob);
});

test('a failed transcription still reaches Telegram, marked as failed', async () => {
  const { service, calls } = await makeArchive();
  const kept = await service.keep(audio);

  await service.publish(kept, { error: 'Voice backend timed out' });

  assert.match(String(calls[0].form.get('caption')), /Расшифровка не удалась: Voice backend timed out/);
  assert.match(await fs.readFile(kept!.audioPath.replace('.webm', '.txt'), 'utf8'), /не удалась/);
});

test('falls back to sending the original file when conversion fails', async () => {
  const { service, calls, warnings } = await makeArchive({
    convertToVoice: async () => { throw new Error('ffmpeg missing'); },
  });
  const kept = await service.keep(audio);

  await service.publish(kept, { text: 'текст' });

  assert.match(calls[0].url, /sendDocument$/);
  assert.ok(calls[0].form.get('document') instanceof Blob);
  assert.ok(warnings.some((w) => w.includes('ffmpeg missing')));
});

test('a Telegram outage never rejects and the disk copy stays', async () => {
  const { service } = await makeArchive({
    fetchTelegram: (async () => new Response('down', { status: 502 })) as typeof fetch,
  });
  const kept = await service.keep(audio);

  await service.publish(kept, { text: 'текст' });

  assert.deepEqual(await fs.readFile(kept!.audioPath), audio.bytes);
});

test('without Telegram credentials the recording is kept on disk only', async () => {
  const { service, calls } = await makeArchive({ botToken: '' });
  const kept = await service.keep(audio);

  await service.publish(kept, { text: 'текст' });

  assert.ok(kept);
  assert.equal(calls.length, 0);
});

test('without an archive directory nothing is kept or sent', async () => {
  const { service, calls } = await makeArchive({ archiveDir: '' });

  assert.equal(service.mayArchiveCurrentRequest(), false);
  assert.equal(await service.keep(audio), null);
  await service.publish(null, { text: 'текст' });
  assert.equal(calls.length, 0);
});

test('a guest request on a shared instance is not archivable', async () => {
  const { service } = await makeArchive({ isArchivableRequest: () => false });

  assert.equal(service.mayArchiveCurrentRequest(), false);
});

test('sweep removes only archive files older than the retention period', async () => {
  const { service, archiveDir } = await makeArchive();
  const old = path.join(archiveDir, '2026-08-30_10-00-00_abcdef.webm');
  const oldText = path.join(archiveDir, '2026-08-30_10-00-00_abcdef.txt');
  const fresh = path.join(archiveDir, '2026-09-10_10-00-00_123456.webm');
  const foreign = path.join(archiveDir, 'notes.webm');
  for (const file of [old, oldText, fresh, foreign]) {
    await fs.writeFile(file, 'x');
  }
  const fifteenDaysAgo = new Date('2026-08-31T13:00:00Z');
  const tenDaysAgo = new Date('2026-09-05T13:00:00Z');
  await fs.utimes(old, fifteenDaysAgo, fifteenDaysAgo);
  await fs.utimes(oldText, fifteenDaysAgo, fifteenDaysAgo);
  await fs.utimes(foreign, fifteenDaysAgo, fifteenDaysAgo);
  await fs.utimes(fresh, tenDaysAgo, tenDaysAgo);

  const removed = await service.sweepExpired();

  assert.equal(removed, 2);
  assert.deepEqual((await fs.readdir(archiveDir)).sort(), ['2026-09-10_10-00-00_123456.webm', 'notes.webm']);
});
