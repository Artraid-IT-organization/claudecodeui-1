/**
 * Keeps every dictated recording: on disk for a fixed number of days, and as a
 * voice message in a Telegram group.
 *
 * The web composer is the only place these recordings exist: the transcript
 * goes into the message box and the audio itself used to be dropped the moment
 * the request finished. A recording lost to a failed transcription, a closed
 * tab or an erased draft could not be recovered (15.09.26 - the owner asked
 * for exactly that and there was nothing to give back).
 *
 * Properties this must have, in order of importance:
 *
 * 1. It can never break dictation. Every archive call swallows and logs its
 *    own failures; the Telegram upload runs detached from the HTTP response.
 * 2. The recording is on disk BEFORE transcription starts, so a transcription
 *    that fails or hangs still leaves the audio behind.
 * 3. It is off unless configured. No archive directory - nothing is kept or
 *    sent anywhere.
 * 4. On a multi-tenant instance it archives the OWNER's recordings only. The
 *    destination group is the host's private one; posting an invited guest's
 *    voice into it would be handing one person's audio to another.
 * 5. Retention deletes only files this service named, only inside its own
 *    directory.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Telegram's Bot API refuses uploads above 50 MB. Checked before spending
 * minutes uploading something that can only be rejected at the end.
 */
const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Telegram truncates captions past this; cut it ourselves so it reads cleanly. */
const TELEGRAM_MAX_CAPTION_CHARS = 1024;

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Only names produced by `buildBaseName` + a known extension are ever deleted,
 * so a stray file someone drops into the directory survives the sweep.
 */
const ARCHIVE_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.(webm|m4a|ogg|mp3|wav|txt)$/;

type ArchivedAudio = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

/** Outcome of the transcription the recording was uploaded for. */
type TranscriptionOutcome = { text: string } | { error: string };

/** A recording already written to disk, waiting for its transcription outcome. */
export type KeptRecording = {
  audioPath: string;
  recordedAt: Date;
  byteLength: number;
};

type AudioArchiveDependencies = {
  /** Where recordings are kept. Empty string disables the whole archive. */
  archiveDir: string;
  retentionDays: number;
  /** Telegram delivery is skipped (disk copy still kept) when either is empty. */
  botToken: string;
  chatId: string;
  fetchTelegram: typeof fetch;
  /** Converts any browser recording into OGG/Opus - the only format Telegram shows as a voice message. */
  convertToVoice: (inputPath: string, outputPath: string) => Promise<void>;
  /** True when the current HTTP request belongs to someone whose audio may be archived. */
  isArchivableRequest: () => boolean;
  log: Pick<Console, 'warn' | 'info'>;
  now: () => Date;
};

function moscowParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** `2026-09-15_16-05-03_a1b2c3` - sorts by time and reads without opening the file. */
function buildBaseName(date: Date): string {
  const p = moscowParts(date);
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}_${randomBytes(3).toString('hex')}`;
}

function pickExtension(audio: ArchivedAudio): string {
  const mime = audio.mimeType.toLowerCase();
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  const fromName = path.extname(audio.fileName).slice(1).toLowerCase();
  return ['webm', 'm4a', 'ogg', 'mp3', 'wav'].includes(fromName) ? fromName : 'webm';
}

function buildCaption(outcome: TranscriptionOutcome, recordedAt: Date): string {
  const p = moscowParts(recordedAt);
  const header = `🎙 Claude UI · ${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}\n`;
  const body = 'error' in outcome
    ? `⚠️ Расшифровка не удалась: ${outcome.error}`
    : (outcome.text.trim() || '(расшифровка пустая)');
  const room = TELEGRAM_MAX_CAPTION_CHARS - header.length;
  return header + (body.length > room ? `${body.slice(0, room - 1)}…` : body);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the archive used by the Voice composition root (voice.module.ts) and
 * wired into the transcription route (voice.routes.ts).
 */
export function createAudioArchiveService(dependencies: AudioArchiveDependencies) {
  const enabled = Boolean(dependencies.archiveDir);
  const telegramEnabled = Boolean(dependencies.botToken && dependencies.chatId);

  async function postToTelegram(method: string, form: FormData): Promise<void> {
    const response = await dependencies.fetchTelegram(
      `https://api.telegram.org/bot${dependencies.botToken}/${method}`,
      { method: 'POST', body: form },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Telegram ${method} replied ${response.status}: ${detail.slice(0, 200)}`);
    }
  }

  async function sendToTelegram(recording: KeptRecording, caption: string): Promise<void> {
    const voicePath = path.join(
      os.tmpdir(),
      `voice-archive-${path.basename(recording.audioPath, path.extname(recording.audioPath))}.ogg`,
    );
    try {
      let converted = false;
      try {
        await dependencies.convertToVoice(recording.audioPath, voicePath);
        converted = true;
      } catch (error) {
        dependencies.log.warn(`[Voice] Could not convert recording to a voice message, sending the file as is: ${describeError(error)}`);
      }

      const uploadPath = converted ? voicePath : recording.audioPath;
      // Размер — до чтения: отбракованный файл не должен занимать память.
      const { size } = await fs.stat(uploadPath);
      if (size > TELEGRAM_MAX_UPLOAD_BYTES) {
        dependencies.log.warn(
          `[Voice] Recording of ${Math.round(size / 1024 / 1024)} MB exceeds `
          + "Telegram's 50 MB upload limit - kept on disk only.",
        );
        return;
      }
      const bytes = await fs.readFile(uploadPath);

      const form = new FormData();
      form.append('chat_id', dependencies.chatId);
      form.append('caption', caption);
      if (converted) {
        form.append('voice', new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }), 'recording.ogg');
        await postToTelegram('sendVoice', form);
      } else {
        form.append('document', new Blob([new Uint8Array(bytes)]), path.basename(recording.audioPath));
        await postToTelegram('sendDocument', form);
      }
    } finally {
      await fs.rm(voicePath, { force: true }).catch(() => undefined);
    }
  }

  return {
    /**
     * Must be called synchronously in the route handler, before the multipart
     * body is parsed: the upload parser's callbacks run outside the request's
     * async context, where the requester is no longer known.
     */
    mayArchiveCurrentRequest(): boolean {
      return enabled && dependencies.isArchivableRequest();
    },

    /**
     * Writes the recording to disk before transcription. Never rejects;
     * returns null when the archive is off or the write failed.
     */
    async keep(audio: ArchivedAudio): Promise<KeptRecording | null> {
      if (!enabled) {
        return null;
      }
      const recordedAt = dependencies.now();
      const audioPath = path.join(
        dependencies.archiveDir,
        `${buildBaseName(recordedAt)}.${pickExtension(audio)}`,
      );
      try {
        await fs.mkdir(dependencies.archiveDir, { recursive: true, mode: 0o700 });
        // mode у mkdir не действует на уже существующую папку — записи личные.
        await fs.chmod(dependencies.archiveDir, 0o700);
        await fs.writeFile(audioPath, audio.bytes, { mode: 0o600 });
        return { audioPath, recordedAt, byteLength: audio.bytes.byteLength };
      } catch (error) {
        dependencies.log.warn(`[Voice] Could not keep recording on disk: ${describeError(error)}`);
        return null;
      }
    },

    /**
     * Saves the transcript next to the audio and posts both to Telegram.
     * Fire-and-forget: returns immediately and never rejects. The returned
     * promise exists for tests; callers must not wait on it.
     */
    publish(recording: KeptRecording | null, outcome: TranscriptionOutcome): Promise<void> {
      if (!recording) {
        return Promise.resolve();
      }
      const textPath = recording.audioPath.replace(/\.[^.]+$/, '.txt');
      const text = 'error' in outcome ? `Расшифровка не удалась: ${outcome.error}\n` : `${outcome.text}\n`;

      return (async () => {
        await fs.writeFile(textPath, text, { mode: 0o600 }).catch((error: unknown) => {
          dependencies.log.warn(`[Voice] Could not save transcript next to the recording: ${describeError(error)}`);
        });
        if (telegramEnabled) {
          await sendToTelegram(recording, buildCaption(outcome, recording.recordedAt));
        }
      })().catch((error: unknown) => {
        dependencies.log.warn(`[Voice] Could not archive recording to Telegram: ${describeError(error)}`);
      });
    },

    /** Deletes archived files older than the retention period. Returns how many were removed. */
    async sweepExpired(): Promise<number> {
      if (!enabled) {
        return 0;
      }
      const cutoff = dependencies.now().getTime() - dependencies.retentionDays * 24 * 60 * 60 * 1000;
      let removed = 0;
      let names: string[];
      try {
        names = await fs.readdir(dependencies.archiveDir);
      } catch {
        return 0;
      }
      for (const name of names) {
        if (!ARCHIVE_FILE_PATTERN.test(name)) continue;
        const filePath = path.join(dependencies.archiveDir, name);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            await fs.rm(filePath);
            removed += 1;
          }
        } catch (error) {
          dependencies.log.warn(`[Voice] Could not remove expired recording ${name}: ${describeError(error)}`);
        }
      }
      if (removed > 0) {
        dependencies.log.info(`[Voice] Removed ${removed} archived file(s) older than ${dependencies.retentionDays} days`);
      }
      return removed;
    },

    /** Sweeps once now and then every six hours; the timer never keeps the process alive. */
    startRetentionSweep(): void {
      if (!enabled) {
        return;
      }
      const sweep = () => { void this.sweepExpired(); };
      sweep();
      setInterval(sweep, SWEEP_INTERVAL_MS).unref();
    },
  };
}

export type AudioArchiveService = ReturnType<typeof createAudioArchiveService>;
