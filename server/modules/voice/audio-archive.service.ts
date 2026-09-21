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
 * 2. The recording is on disk BEFORE transcription starts, and on its way to
 *    Telegram BEFORE transcription finishes. A transcription that fails, hangs
 *    or dies with the process still leaves the audio both on disk and in the
 *    owner's chat (21.09.26 - a restart 19 seconds after a recording killed
 *    the detached upload, which back then only started once the transcript was
 *    ready; the audio sat on disk and reached nobody).
 * 3. Delivery state lives next to the recording, so a recording interrupted
 *    mid-delivery is finished on the next start instead of being lost.
 * 4. It is off unless configured. No archive directory - nothing is kept or
 *    sent anywhere.
 * 5. On a multi-tenant instance it archives the OWNER's recordings only. The
 *    destination group is the host's private one; posting an invited guest's
 *    voice into it would be handing one person's audio to another.
 * 6. Retention deletes only files this service named, only inside its own
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
 * Upper bound for one resume pass. A directory that somehow accumulated a
 * backlog must not turn into a burst of dozens of voice messages.
 */
const MAX_RESUMED_PER_PASS = 20;

/** Расширения, под которыми служба сохраняет саму запись. */
const AUDIO_EXTENSIONS = ['webm', 'm4a', 'ogg', 'mp3', 'wav'] as const;

/**
 * Only names produced by `buildBaseName` + a known extension are ever deleted,
 * so a stray file someone drops into the directory survives the sweep.
 */
const ARCHIVE_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.(webm|m4a|ogg|mp3|wav)(\.tg\.json)?$|^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.txt$/;

const AUDIO_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.(webm|m4a|ogg|mp3|wav)$/;

/**
 * Marks the directory as already known to the resume pass. Without it the very
 * first start after this code ships would treat every recording ever made as
 * undelivered and repost the lot.
 */
const RESUME_INITIALIZED_MARKER = '.resume-initialized';

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

/**
 * How far a recording got on its way to Telegram. Written next to the audio
 * after every step, so an interrupted delivery is visible to the next start.
 */
type DeliveryState = {
  /** Set once the voice message exists in the chat; its caption can be edited. */
  messageId?: number;
  /** The audio reached Telegram even if the message id could not be read back. */
  sent?: boolean;
  /** The caption already carries the transcription outcome - nothing left to add. */
  captionDone?: boolean;
  /** Recording predates the resume pass; it is not delivered retroactively. */
  legacy?: boolean;
};

/** What one Telegram upload produced. */
type SendResult = { sent: boolean; messageId: number | null };

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
  return (AUDIO_EXTENSIONS as readonly string[]).includes(fromName) ? fromName : 'webm';
}

function captionHeader(recordedAt: Date): string {
  const p = moscowParts(recordedAt);
  return `🎙 Claude UI · ${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}\n`;
}

function clampToCaption(header: string, body: string): string {
  const room = TELEGRAM_MAX_CAPTION_CHARS - header.length;
  return header + (body.length > room ? `${body.slice(0, room - 1)}…` : body);
}

/**
 * Caption the voice message carries while the transcript is still being made.
 * It is replaced by the outcome as soon as there is one; if the process dies
 * first, this is what the owner sees - and it says so plainly.
 */
function pendingCaption(recordedAt: Date): string {
  return `${captionHeader(recordedAt)}⏳ Расшифровка идёт…`;
}

function buildCaption(outcome: TranscriptionOutcome, recordedAt: Date): string {
  const body = 'error' in outcome
    ? `⚠️ Расшифровка не удалась: ${outcome.error}`
    : (outcome.text.trim() || '(расшифровка пустая)');
  return clampToCaption(captionHeader(recordedAt), body);
}

/** Caption for a recording resumed after a restart, when only the saved transcript is left. */
function resumedCaption(recordedAt: Date, transcript: string | null): string {
  const body = transcript?.trim()
    ? transcript.trim()
    : '⚠️ Расшифровка не дошла — запись сохранена целиком.';
  return clampToCaption(captionHeader(recordedAt), body);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statePathFor(audioPath: string): string {
  return `${audioPath}.tg.json`;
}

function textPathFor(audioPath: string): string {
  return audioPath.replace(/\.[^.]+$/, '.txt');
}

/** Restores the recording time from the file name; falls back to mtime. */
function recordedAtFromName(name: string, fallback: Date): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_/.exec(name);
  if (!match) {
    return fallback;
  }
  const [, year, month, day, hour, minute, second] = match;
  // Имя записано по Москве (UTC+3) - возвращаем тот же момент в UTC.
  const asUtc = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour) - 3, Number(minute), Number(second),
  );
  return Number.isFinite(asUtc) ? new Date(asUtc) : fallback;
}

/**
 * Creates the archive used by the Voice composition root (voice.module.ts) and
 * wired into the transcription route (voice.routes.ts).
 */
export function createAudioArchiveService(dependencies: AudioArchiveDependencies) {
  const enabled = Boolean(dependencies.archiveDir);
  const telegramEnabled = Boolean(dependencies.botToken && dependencies.chatId);

  /**
   * In-flight uploads by audio path. `publishOutcome` waits on the upload its
   * own recording started instead of racing it: the transcript is usually
   * ready before a multi-megabyte upload finishes.
   */
  const inFlightSends = new Map<string, Promise<SendResult>>();

  async function readState(audioPath: string): Promise<DeliveryState> {
    try {
      const raw = await fs.readFile(statePathFor(audioPath), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as DeliveryState : {};
    } catch {
      return {};
    }
  }

  async function writeState(audioPath: string, patch: DeliveryState): Promise<void> {
    const merged = { ...await readState(audioPath), ...patch };
    await fs.writeFile(statePathFor(audioPath), `${JSON.stringify(merged)}\n`, { mode: 0o600 })
      .catch((error: unknown) => {
        dependencies.log.warn(`[Voice] Could not record delivery state: ${describeError(error)}`);
      });
  }

  async function readTranscript(audioPath: string): Promise<string | null> {
    try {
      return await fs.readFile(textPathFor(audioPath), 'utf8');
    } catch {
      return null;
    }
  }

  async function postToTelegram(method: string, form: FormData): Promise<number | null> {
    const response = await dependencies.fetchTelegram(
      `https://api.telegram.org/bot${dependencies.botToken}/${method}`,
      { method: 'POST', body: form },
    );
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`Telegram ${method} replied ${response.status}: ${raw.slice(0, 200)}`);
    }
    try {
      const parsed = JSON.parse(raw) as { result?: { message_id?: number } };
      const messageId = parsed.result?.message_id;
      return typeof messageId === 'number' ? messageId : null;
    } catch {
      return null;
    }
  }

  /** Uploads the recording itself. Returns whether it landed and under which message id. */
  async function sendRecording(audioPath: string, caption: string): Promise<SendResult> {
    const voicePath = path.join(
      os.tmpdir(),
      `voice-archive-${path.basename(audioPath, path.extname(audioPath))}.ogg`,
    );
    try {
      let converted = false;
      try {
        await dependencies.convertToVoice(audioPath, voicePath);
        converted = true;
      } catch (error) {
        dependencies.log.warn(`[Voice] Could not convert recording to a voice message, sending the file as is: ${describeError(error)}`);
      }

      const uploadPath = converted ? voicePath : audioPath;
      // Размер — до чтения: отбракованный файл не должен занимать память.
      const { size } = await fs.stat(uploadPath);
      if (size > TELEGRAM_MAX_UPLOAD_BYTES) {
        dependencies.log.warn(
          `[Voice] Recording of ${Math.round(size / 1024 / 1024)} MB exceeds `
          + "Telegram's 50 MB upload limit - kept on disk only.",
        );
        return { sent: false, messageId: null };
      }
      const bytes = await fs.readFile(uploadPath);

      const form = new FormData();
      form.append('chat_id', dependencies.chatId);
      form.append('caption', caption);
      let messageId: number | null;
      if (converted) {
        form.append('voice', new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }), 'recording.ogg');
        messageId = await postToTelegram('sendVoice', form);
      } else {
        form.append('document', new Blob([new Uint8Array(bytes)]), path.basename(audioPath));
        messageId = await postToTelegram('sendDocument', form);
      }
      return { sent: true, messageId };
    } finally {
      await fs.rm(voicePath, { force: true }).catch(() => undefined);
    }
  }

  /** Replaces the caption of an already delivered voice message. */
  async function editCaption(messageId: number, caption: string): Promise<void> {
    const form = new FormData();
    form.append('chat_id', dependencies.chatId);
    form.append('message_id', String(messageId));
    form.append('caption', caption);
    await postToTelegram('editMessageCaption', form);
  }

  /**
   * Puts the transcription outcome where the owner will see it: into the
   * caption of the voice message when there is one, as a follow-up message
   * when the upload came back without an id, and as a fresh upload when the
   * audio never made it at all.
   */
  async function deliverOutcomeText(
    audioPath: string,
    caption: string,
    previous: SendResult,
  ): Promise<void> {
    if (previous.messageId !== null) {
      await editCaption(previous.messageId, caption);
      await writeState(audioPath, { captionDone: true });
      return;
    }

    if (previous.sent) {
      // Аудио у владельца, но подпись править не по чему - шлём текст следом.
      const form = new FormData();
      form.append('chat_id', dependencies.chatId);
      form.append('text', caption);
      await postToTelegram('sendMessage', form);
      await writeState(audioPath, { captionDone: true });
      return;
    }

    // Первая отправка не удалась - вторая попытка, уже с готовой подписью.
    const retry = await sendRecording(audioPath, caption);
    await writeState(audioPath, {
      sent: retry.sent,
      captionDone: retry.sent,
      ...(retry.messageId === null ? {} : { messageId: retry.messageId }),
    });
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
     * Starts the Telegram upload immediately, without waiting for the
     * transcript: this is the step that survives a failed, hung or killed
     * transcription. Fire-and-forget; never rejects.
     */
    publishAudio(recording: KeptRecording | null): Promise<void> {
      if (!recording || !telegramEnabled) {
        return Promise.resolve();
      }
      const { audioPath, recordedAt } = recording;
      const task = sendRecording(audioPath, pendingCaption(recordedAt))
        .then(async (result) => {
          await writeState(audioPath, {
            sent: result.sent,
            ...(result.messageId === null ? {} : { messageId: result.messageId }),
          });
          return result;
        })
        .catch((error: unknown) => {
          dependencies.log.warn(`[Voice] Could not send recording to Telegram: ${describeError(error)}`);
          return { sent: false, messageId: null } as SendResult;
        });
      inFlightSends.set(audioPath, task);
      return task.then(() => undefined);
    },

    /**
     * Saves the transcript next to the audio and shows it under the recording
     * in Telegram. Fire-and-forget: returns immediately and never rejects. The
     * returned promise exists for tests; callers must not wait on it.
     */
    publishOutcome(recording: KeptRecording | null, outcome: TranscriptionOutcome): Promise<void> {
      if (!recording) {
        return Promise.resolve();
      }
      const { audioPath, recordedAt } = recording;
      const text = 'error' in outcome ? `Расшифровка не удалась: ${outcome.error}\n` : `${outcome.text}\n`;

      return (async () => {
        await fs.writeFile(textPathFor(audioPath), text, { mode: 0o600 }).catch((error: unknown) => {
          dependencies.log.warn(`[Voice] Could not save transcript next to the recording: ${describeError(error)}`);
        });
        if (!telegramEnabled) {
          return;
        }
        const previous = await (inFlightSends.get(audioPath) ?? Promise.resolve({ sent: false, messageId: null }));
        inFlightSends.delete(audioPath);
        await deliverOutcomeText(audioPath, buildCaption(outcome, recordedAt), previous);
      })().catch((error: unknown) => {
        dependencies.log.warn(`[Voice] Could not archive recording to Telegram: ${describeError(error)}`);
      });
    },

    /**
     * Finishes deliveries interrupted by a restart: a recording that never
     * reached Telegram is sent, one whose caption still says "in progress" is
     * updated from the saved transcript. Recordings already in the directory
     * the first time this runs are marked instead of resent.
     */
    async resumePending(): Promise<number> {
      if (!enabled || !telegramEnabled) {
        return 0;
      }

      let names: string[];
      try {
        names = (await fs.readdir(dependencies.archiveDir)).filter((name) => AUDIO_FILE_PATTERN.test(name)).sort();
      } catch {
        return 0;
      }

      const markerPath = path.join(dependencies.archiveDir, RESUME_INITIALIZED_MARKER);
      const firstRun = !(await fs.access(markerPath).then(() => true, () => false));
      if (firstRun) {
        for (const name of names) {
          const audioPath = path.join(dependencies.archiveDir, name);
          if (Object.keys(await readState(audioPath)).length === 0) {
            await writeState(audioPath, { legacy: true });
          }
        }
        await fs.writeFile(markerPath, `${new Date().toISOString()}\n`, { mode: 0o600 }).catch(() => undefined);
        return 0;
      }

      const cutoff = dependencies.now().getTime() - dependencies.retentionDays * 24 * 60 * 60 * 1000;
      let resumed = 0;
      for (const name of names) {
        if (resumed >= MAX_RESUMED_PER_PASS) {
          dependencies.log.warn(`[Voice] Stopped resuming after ${MAX_RESUMED_PER_PASS} recordings; the rest waits for the next pass`);
          break;
        }
        const audioPath = path.join(dependencies.archiveDir, name);
        const state = await readState(audioPath);
        if (state.legacy || state.captionDone) {
          continue;
        }
        const recordedAt = recordedAtFromName(name, dependencies.now());
        if (recordedAt.getTime() < cutoff) {
          continue;
        }
        const transcript = await readTranscript(audioPath);
        const caption = resumedCaption(recordedAt, transcript);
        try {
          await deliverOutcomeText(audioPath, caption, {
            sent: Boolean(state.sent),
            messageId: state.messageId ?? null,
          });
          resumed += 1;
        } catch (error) {
          dependencies.log.warn(`[Voice] Could not finish delivery of ${name}: ${describeError(error)}`);
        }
      }
      if (resumed > 0) {
        dependencies.log.info(`[Voice] Finished delivery of ${resumed} recording(s) interrupted earlier`);
      }
      return resumed;
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

    /**
     * Finishes interrupted deliveries and sweeps expired files once now, then
     * every six hours; the timer never keeps the process alive.
     */
    startRetentionSweep(): void {
      if (!enabled) {
        return;
      }
      const pass = () => {
        void this.resumePending().then(() => this.sweepExpired());
      };
      pass();
      setInterval(pass, SWEEP_INTERVAL_MS).unref();
    },
  };
}

export type AudioArchiveService = ReturnType<typeof createAudioArchiveService>;
