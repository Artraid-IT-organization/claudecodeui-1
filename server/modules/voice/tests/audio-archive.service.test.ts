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
  let nextMessageId = 7000;
  const service = createAudioArchiveService({
    archiveDir,
    retentionDays: 14,
    botToken: 'token',
    chatId: '-100500',
    fetchTelegram: (async (url: string, init?: RequestInit) => {
      calls.push({ url, form: init?.body as FormData });
      nextMessageId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId } }), { status: 200 });
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

/** Marks the directory as seen, so `resumePending` works on it instead of backfilling. */
async function markResumeInitialized(archiveDir: string): Promise<void> {
  await fs.writeFile(path.join(archiveDir, '.resume-initialized'), 'test\n');
}

function captionsOf(calls: TelegramCall[]): string[] {
  return calls.map((call) => String(call.form.get('caption')));
}

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

test('the audio reaches Telegram before the transcript exists', async () => {
  const { service, calls } = await makeArchive();
  const kept = await service.keep(audio);

  await service.publishAudio(kept);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/bottoken\/sendVoice$/);
  assert.equal(calls[0].form.get('chat_id'), '-100500');
  assert.equal(calls[0].form.get('caption'), '🎙 Claude UI · 15.09.2026 16:05\n⏳ Расшифровка идёт…');
  assert.ok(calls[0].form.get('voice') instanceof Blob);
  assert.deepEqual(JSON.parse(await fs.readFile(`${kept!.audioPath}.tg.json`, 'utf8')), {
    sent: true,
    messageId: 7001,
  });
});

test('the transcript replaces the caption of the message already sent', async () => {
  const { service, calls } = await makeArchive();
  const kept = await service.keep(audio);

  await service.publishAudio(kept);
  await service.publishOutcome(kept, { text: 'Купить молоко' });

  assert.equal(await fs.readFile(kept!.audioPath.replace('.webm', '.txt'), 'utf8'), 'Купить молоко\n');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/editMessageCaption$/);
  assert.equal(calls[1].form.get('message_id'), '7001');
  assert.equal(calls[1].form.get('caption'), '🎙 Claude UI · 15.09.2026 16:05\nКупить молоко');
  assert.equal(JSON.parse(await fs.readFile(`${kept!.audioPath}.tg.json`, 'utf8')).captionDone, true);
});

test('a failed transcription still shows up under the recording, marked as failed', async () => {
  const { service, calls } = await makeArchive();
  const kept = await service.keep(audio);

  await service.publishAudio(kept);
  await service.publishOutcome(kept, { error: 'Voice backend timed out' });

  assert.match(String(calls[1].form.get('caption')), /Расшифровка не удалась: Voice backend timed out/);
  assert.match(await fs.readFile(kept!.audioPath.replace('.webm', '.txt'), 'utf8'), /не удалась/);
});

test('an outcome arriving without a prior upload sends the recording itself', async () => {
  const { service, calls } = await makeArchive();
  const kept = await service.keep(audio);

  await service.publishOutcome(kept, { text: 'текст' });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendVoice$/);
  assert.equal(calls[0].form.get('caption'), '🎙 Claude UI · 15.09.2026 16:05\nтекст');
});

test('falls back to sending the original file when conversion fails', async () => {
  const { service, calls, warnings } = await makeArchive({
    convertToVoice: async () => { throw new Error('ffmpeg missing'); },
  });
  const kept = await service.keep(audio);

  await service.publishAudio(kept);

  assert.match(calls[0].url, /sendDocument$/);
  assert.ok(calls[0].form.get('document') instanceof Blob);
  assert.ok(warnings.some((w) => w.includes('ffmpeg missing')));
});

test('a Telegram outage never rejects and the disk copy stays', async () => {
  const { service } = await makeArchive({
    fetchTelegram: (async () => new Response('down', { status: 502 })) as typeof fetch,
  });
  const kept = await service.keep(audio);

  await service.publishAudio(kept);
  await service.publishOutcome(kept, { text: 'текст' });

  assert.deepEqual(await fs.readFile(kept!.audioPath), audio.bytes);
});

test('without Telegram credentials the recording is kept on disk only', async () => {
  const { service, calls } = await makeArchive({ botToken: '' });
  const kept = await service.keep(audio);

  await service.publishAudio(kept);
  await service.publishOutcome(kept, { text: 'текст' });

  assert.ok(kept);
  assert.equal(calls.length, 0);
  assert.equal(await fs.readFile(kept!.audioPath.replace('.webm', '.txt'), 'utf8'), 'текст\n');
});

test('without an archive directory nothing is kept or sent', async () => {
  const { service, calls } = await makeArchive({ archiveDir: '' });

  assert.equal(service.mayArchiveCurrentRequest(), false);
  assert.equal(await service.keep(audio), null);
  await service.publishAudio(null);
  await service.publishOutcome(null, { text: 'текст' });
  assert.equal(calls.length, 0);
});

test('a guest request on a shared instance is not archivable', async () => {
  const { service } = await makeArchive({ isArchivableRequest: () => false });

  assert.equal(service.mayArchiveCurrentRequest(), false);
});

test('the first resume pass marks what is already there instead of reposting it', async () => {
  const { service, archiveDir, calls } = await makeArchive();
  const kept = await service.keep(audio);

  const resumed = await service.resumePending();

  assert.equal(resumed, 0);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(await fs.readFile(`${kept!.audioPath}.tg.json`, 'utf8')).legacy, true);
  assert.ok((await fs.readdir(archiveDir)).includes('.resume-initialized'));
});

test('a recording killed before its upload is sent on the next start, with the saved transcript', async () => {
  const { service, archiveDir, calls } = await makeArchive();
  await markResumeInitialized(archiveDir);
  const kept = await service.keep(audio);
  // Расшифровка успела лечь на диск, отправку убил перезапуск.
  await fs.writeFile(kept!.audioPath.replace('.webm', '.txt'), 'Поправь телемост\n');

  const resumed = await service.resumePending();

  assert.equal(resumed, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendVoice$/);
  assert.equal(calls[0].form.get('caption'), '🎙 Claude UI · 15.09.2026 16:05\nПоправь телемост');
  assert.equal(JSON.parse(await fs.readFile(`${kept!.audioPath}.tg.json`, 'utf8')).captionDone, true);
});

test('a recording killed before transcription finished is sent saying so', async () => {
  const { service, archiveDir, calls } = await makeArchive();
  await markResumeInitialized(archiveDir);
  await service.keep(audio);

  await service.resumePending();

  assert.match(captionsOf(calls)[0], /Расшифровка не дошла/);
});

test('a recording whose caption is still "in progress" gets the transcript on the next start', async () => {
  const { service, archiveDir, calls } = await makeArchive();
  await markResumeInitialized(archiveDir);
  const kept = await service.keep(audio);
  await service.publishAudio(kept);
  await fs.writeFile(kept!.audioPath.replace('.webm', '.txt'), 'Готовый текст\n');
  calls.length = 0;

  const resumed = await service.resumePending();

  assert.equal(resumed, 1);
  assert.match(calls[0].url, /editMessageCaption$/);
  assert.equal(calls[0].form.get('message_id'), '7001');
  assert.equal(calls[0].form.get('caption'), '🎙 Claude UI · 15.09.2026 16:05\nГотовый текст');
});

test('a fully delivered recording is not touched again', async () => {
  const { service, archiveDir, calls } = await makeArchive();
  await markResumeInitialized(archiveDir);
  const kept = await service.keep(audio);
  await service.publishAudio(kept);
  await service.publishOutcome(kept, { text: 'Купить молоко' });
  calls.length = 0;

  assert.equal(await service.resumePending(), 0);
  assert.equal(calls.length, 0);
});

test('recordings past the retention period are not resurrected by a resume pass', async () => {
  const { service, archiveDir, calls } = await makeArchive();
  await markResumeInitialized(archiveDir);
  await fs.writeFile(path.join(archiveDir, '2026-08-01_10-00-00_abcdef.webm'), 'old');

  assert.equal(await service.resumePending(), 0);
  assert.equal(calls.length, 0);
});

test('sweep removes only archive files older than the retention period', async () => {
  const { service, archiveDir } = await makeArchive();
  const old = path.join(archiveDir, '2026-08-30_10-00-00_abcdef.webm');
  const oldText = path.join(archiveDir, '2026-08-30_10-00-00_abcdef.txt');
  const oldState = path.join(archiveDir, '2026-08-30_10-00-00_abcdef.webm.tg.json');
  const fresh = path.join(archiveDir, '2026-09-10_10-00-00_123456.webm');
  const foreign = path.join(archiveDir, 'notes.webm');
  for (const file of [old, oldText, oldState, fresh, foreign]) {
    await fs.writeFile(file, 'x');
  }
  const fifteenDaysAgo = new Date('2026-08-31T13:00:00Z');
  const tenDaysAgo = new Date('2026-09-05T13:00:00Z');
  for (const file of [old, oldText, oldState, foreign]) {
    await fs.utimes(file, fifteenDaysAgo, fifteenDaysAgo);
  }
  await fs.utimes(fresh, tenDaysAgo, tenDaysAgo);

  const removed = await service.sweepExpired();

  assert.equal(removed, 3);
  assert.deepEqual((await fs.readdir(archiveDir)).sort(), ['2026-09-10_10-00-00_123456.webm', 'notes.webm']);
});
