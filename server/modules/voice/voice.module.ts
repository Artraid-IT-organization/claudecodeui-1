import { execFile } from 'node:child_process';
import fs from 'node:fs';

import multer from 'multer';

import { getRequestRuntimeContext } from '@/shared/request-context.js';
import { OPEN_REGISTRATION, isPlatformOwnerWebUser } from '@/shared/utils.js';

import { createAudioArchiveService } from './audio-archive.service.js';
import { createVoiceRouter } from './voice.routes.js';
import { createVoiceService } from './voice.service.js';

// Recognition runs at roughly a fifth of real time on this class of machine
// (measured: a 10-minute recording came back in 2 minutes, end to end through
// nginx and the dictation cascade). Five minutes of budget therefore cut off
// anything past ~25 minutes of speech mid-flight, which the UI could only
// report as a dropped recording. Half an hour covers a couple of hours of
// dictation and still fails eventually rather than hanging forever.
const DEFAULT_VOICE_TIMEOUT_MS = 1_800_000;
const parsedTimeoutMs = Number(process.env.VOICE_TIMEOUT_MS);
const voiceTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
  ? parsedTimeoutMs
  : DEFAULT_VOICE_TIMEOUT_MS;

// Upload ceiling for one recording. Kept in step with client_max_body_size in
// the nginx blocks (deploy/ + /etc/nginx/conf.d/claudecodeui-*): whichever is
// smaller is the real limit, and when nginx is the smaller one it truncates
// the body instead of refusing it, so the app sees a corrupt multipart form
// rather than a size error. 25 MB was about 70 minutes of opus - fine for a
// voice note, short for a dictated session.
const DEFAULT_VOICE_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const parsedMaxUploadBytes = Number(process.env.VOICE_MAX_UPLOAD_BYTES);
const voiceMaxUploadBytes = Number.isFinite(parsedMaxUploadBytes) && parsedMaxUploadBytes > 0
  ? parsedMaxUploadBytes
  : DEFAULT_VOICE_MAX_UPLOAD_BYTES;

const voiceService = createVoiceService({
  defaults: {
    // The server-controlled URL is intentional: frontend-configured custom
    // backends are called directly by the browser and never become SSRF input.
    baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.VOICE_API_KEY || '',
    sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
    ttsModel: process.env.VOICE_TTS_MODEL || 'tts-1',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
  },
  timeoutMs: voiceTimeoutMs,
  fetchBackend: async (url, options) => {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), voiceTimeoutMs);
    try {
      return await fetch(url, {
        redirect: 'manual',
        ...options,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: voiceMaxUploadBytes },
});

/**
 * Reads BOT_TOKEN and CHAT_ID from another bot's env file, so the archive posts
 * into that bot's group without a second copy of its token to keep in sync.
 */
function readTelegramEnvFile(filePath: string): { botToken: string; chatId: string } {
  if (!filePath) {
    return { botToken: '', chatId: '' };
  }
  try {
    const values: Record<string, string> = {};
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match) {
        values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
    return { botToken: values.BOT_TOKEN || '', chatId: values.CHAT_ID || '' };
  } catch (error) {
    console.warn(`[Voice] Could not read AUDIO_ARCHIVE_TG_ENV_FILE: ${error instanceof Error ? error.message : String(error)}`);
    return { botToken: '', chatId: '' };
  }
}

const telegramFromFile = readTelegramEnvFile(process.env.AUDIO_ARCHIVE_TG_ENV_FILE || '');
const parsedRetentionDays = Number(process.env.AUDIO_ARCHIVE_RETENTION_DAYS);

// Каждая продиктованная запись: на диск на AUDIO_ARCHIVE_RETENTION_DAYS дней
// (по умолчанию 14) и голосовым в Telegram-группу. Выключено, пока не задан
// AUDIO_ARCHIVE_DIR; без токена и чата — только диск.
const audioArchive = createAudioArchiveService({
  archiveDir: process.env.AUDIO_ARCHIVE_DIR || '',
  retentionDays: Number.isFinite(parsedRetentionDays) && parsedRetentionDays > 0 ? parsedRetentionDays : 14,
  botToken: process.env.AUDIO_ARCHIVE_TG_TOKEN || telegramFromFile.botToken,
  chatId: process.env.AUDIO_ARCHIVE_TG_CHAT_ID || telegramFromFile.chatId,
  fetchTelegram: fetch,
  convertToVoice: (inputPath, outputPath) => new Promise((resolve, reject) => {
    // nice: перекодирование не должно отнимать процессор у чатов и sshd.
    execFile(
      'nice',
      ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
        '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', outputPath],
      { timeout: 10 * 60 * 1000 },
      (error) => (error ? reject(error) : resolve()),
    );
  }),
  isArchivableRequest: () => {
    if (!OPEN_REGISTRATION) {
      return true;
    }
    const userId = getRequestRuntimeContext()?.userId;
    const numericUserId = userId === undefined || userId === null ? NaN : Number(userId);
    return Number.isFinite(numericUserId) && isPlatformOwnerWebUser(numericUserId);
  },
  log: console,
  now: () => new Date(),
});
audioArchive.startRetentionSweep();

/** Voice router assembled for the server entrypoint. */
export const voiceRoutes = createVoiceRouter({
  voiceService,
  audioArchive,
  parseAudioUpload: audioUpload.single('audio'),
});
