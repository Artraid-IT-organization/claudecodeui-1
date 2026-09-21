import { Readable } from 'node:stream';


import express from 'express';

import type { VoiceRequestOverrides, VoiceService, VoiceServiceResult } from '@/shared/types.js';
import { asyncHandler } from '@/shared/utils.js';

import type { AudioArchiveService } from './audio-archive.service.js';

type VoiceRouterDependencies = {
  voiceService: VoiceService;
  parseAudioUpload: express.RequestHandler;
  /** Необязательная: не задана — копии записей никуда не уходят. */
  audioArchive?: AudioArchiveService;
};

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  const trimmedValue = normalizedValue?.trim();
  return trimmedValue || undefined;
}

function parseVoiceOverrides(request: express.Request): VoiceRequestOverrides {
  return {
    apiKey: readHeaderValue(request.headers['x-voice-api-key']),
    sttModel: readHeaderValue(request.headers['x-voice-stt-model']),
    ttsModel: readHeaderValue(request.headers['x-voice-tts-model']),
    ttsVoice: readHeaderValue(request.headers['x-voice-tts-voice']),
    ttsFormat: readHeaderValue(request.headers['x-voice-tts-format']),
  };
}

function sendFailure<TValue>(
  response: express.Response,
  result: VoiceServiceResult<TValue>,
): result is Extract<VoiceServiceResult<TValue>, { ok: false }> {
  if (result.ok) {
    return false;
  }

  response.status(result.status).json({ error: result.error });
  return true;
}

/**
 * Creates the transport-only router used by the Voice composition root. It is
 * exported for Voice route tests; other modules consume only the composed
 * router exposed from the Voice barrel.
 */
export function createVoiceRouter(dependencies: VoiceRouterDependencies): express.Router {
  const router = express.Router();

  router.get('/health', (_request, response) => {
    response.json(dependencies.voiceService.getHealth());
  });

  router.post('/transcribe', (request, response, next) => {
    // Решается до разбора тела: колбэки multer идут вне контекста запроса,
    // и там уже не видно, чья это запись (владелец или гость общего сайта).
    const archive = dependencies.audioArchive?.mayArchiveCurrentRequest()
      ? dependencies.audioArchive
      : undefined;

    dependencies.parseAudioUpload(request, response, (uploadError?: unknown) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        response.status(400).json({ error: message });
        return;
      }

      // Multer uses a callback API, so bridge its parsed request into the async
      // service call and forward unexpected rejections to Express middleware.
      void (async () => {
        if (!request.file) {
          response.status(400).json({ error: 'No audio uploaded' });
          return;
        }

        const audio = {
          bytes: request.file.buffer,
          mimeType: request.file.mimetype || 'audio/webm',
          fileName: request.file.originalname || 'recording.webm',
        };

        // На диск до распознавания: упавшая или зависшая расшифровка не
        // должна уносить с собой саму запись.
        const kept = archive ? await archive.keep(audio) : null;

        // И в Telegram — тоже до распознавания, не дожидаясь его итога.
        // 21.09.26 перезапуск сервиса через 19 секунд после записи убил
        // отправку, которая тогда стартовала только с готовой расшифровкой:
        // запись осталась на диске и не дошла ни до кого. Без await —
        // загрузка не должна задерживать ответ пользователю.
        void archive?.publishAudio(kept);

        const result = await dependencies.voiceService.transcribe({
          audio,
          overrides: parseVoiceOverrides(request),
        });

        // Без await: ни задержка Telegram, ни его отказ не должны стоить
        // пользователю ответа, который уже готов.
        void archive?.publishOutcome(kept, result.ok ? { text: result.value.text } : { error: result.error });

        if (sendFailure(response, result)) {
          return;
        }

        response.json(result.value);
      })().catch(next);
    });
  });

  router.post('/tts', asyncHandler(async (request, response) => {
    const text = request.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      response.status(400).json({ error: 'text required' });
      return;
    }

    const result = await dependencies.voiceService.synthesizeSpeech({
      text,
      overrides: parseVoiceOverrides(request),
    });
    if (sendFailure(response, result)) {
      return;
    }

    response.setHeader('Content-Type', result.value.contentType);
    response.setHeader('Cache-Control', 'no-store');
    if (!result.value.body) {
      response.end();
      return;
    }

    Readable.fromWeb(result.value.body).on('error', (error) => response.destroy(error)).pipe(response);
  }));

  return router;
}
