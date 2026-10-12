import { Readable } from 'node:stream';


import express from 'express';

import type { StoredVoiceTranscript, VoiceTranscriptTarget } from '@/modules/database/index.js';
import { getRequestRuntimeContext } from '@/shared/request-context.js';
import type { VoiceRequestOverrides, VoiceService, VoiceServiceResult } from '@/shared/types.js';
import { asyncHandler } from '@/shared/utils.js';

import type { AudioArchiveService } from './audio-archive.service.js';

/**
 * The slice of the voice-transcripts repository the routes use. Kept as a
 * dependency parameter (not a direct import) so route tests can stub it and
 * the router stays transport-only, the same discipline as `audioArchive`.
 */
type VoiceTranscriptsRepository = {
  get(recId: string, userId: number): StoredVoiceTranscript | null;
  upsertReceived(target: VoiceTranscriptTarget, userId: number): void;
  setText(recId: string, userId: number, text: string): void;
  listUndelivered(userId: number): StoredVoiceTranscript[];
  markDelivered(recId: string, userId: number): void;
};

type VoiceRouterDependencies = {
  voiceService: VoiceService;
  parseAudioUpload: express.RequestHandler;
  /** Необязательная: не задана — копии записей никуда не уходят. */
  audioArchive?: AudioArchiveService;
  /**
   * Server-side transcript inbox + upload dedupe. Optional so instances
   * without a database keep the old stateless behaviour.
   */
  transcripts?: VoiceTranscriptsRepository;
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
 * Whose transcript row this is. Read at the top of the handler - the multer
 * callbacks below run outside the request's async context, the same trap
 * `mayArchiveCurrentRequest` documents. Single-tenant instances carry no
 * user id in the context and share the `0` bucket.
 */
function readRequestUserId(): number {
  const userId = Number(getRequestRuntimeContext()?.userId);
  return Number.isFinite(userId) ? userId : 0;
}

function readField(body: unknown, name: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

/**
 * Creates the transport-only router used by the Voice composition root. It is
 * exported for Voice route tests; other modules consume only the composed
 * router exposed from the Voice barrel.
 */
export function createVoiceRouter(dependencies: VoiceRouterDependencies): express.Router {
  const router = express.Router();

  router.get('/health', (_request, response) => {
    // `archived` — для текста ошибки в поле ввода: владельцу можно обещать,
    // что запись уже в Telegram, гостю общего сайта — нельзя, его записи
    // никуда не копируются.
    response.json({
      ...dependencies.voiceService.getHealth(),
      archived: dependencies.audioArchive?.mayArchiveCurrentRequest() ?? false,
    });
  });

  router.post('/transcribe', (request, response, next) => {
    // Решается до разбора тела: колбэки multer идут вне контекста запроса,
    // и там уже не видно, чья это запись (владелец или гость общего сайта).
    const archive = dependencies.audioArchive?.mayArchiveCurrentRequest()
      ? dependencies.audioArchive
      : undefined;
    const userId = readRequestUserId();

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

        // Приём + дедуп по номеру записи: телефон шлёт её повторно, пока не
        // увидел ответ, и повтор уже расшифрованной записи не должен плодить
        // второй файл в архиве и второе голосовое в Telegram.
        const recId = readField(request.body, 'clientRecId');
        const transcripts = dependencies.transcripts;
        if (recId && transcripts) {
          const existing = transcripts.get(recId, userId);
          if (existing?.text != null) {
            response.json({ text: existing.text, duplicate: true });
            return;
          }
          transcripts.upsertReceived(
            {
              recId,
              sessionId: readField(request.body, 'targetSession') || null,
              scope: readField(request.body, 'targetScope') || null,
              send: readField(request.body, 'sendIntent') === '1',
            },
            userId,
          );
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

        if (result.ok && recId && transcripts) {
          // Текст лежит на сервере до тех пор, пока клиент не доложит, что
          // положил его в чат, — закрытая в полёте страница ничего не теряет.
          transcripts.setText(recId, userId, result.value.text);
        }

        if (sendFailure(response, result)) {
          return;
        }

        response.json(result.value);
      })().catch(next);
    });
  });

  // Расшифровки, до которых ответ не доехал (страница была закрыта, чат
  // сменился, телефон почистили): клиент забирает список и раскладывает по
  // чатам, подтверждая каждую через /transcripts/delivered.
  router.get('/transcripts/pending', (request, response) => {
    const transcripts = dependencies.transcripts;
    if (!transcripts) {
      response.json({ items: [] });
      return;
    }
    response.json({ items: transcripts.listUndelivered(readRequestUserId()) });
  });

  router.post('/transcripts/delivered', (request, response) => {
    const recId = readField(request.body, 'recId');
    if (recId) {
      dependencies.transcripts?.markDelivered(recId, readRequestUserId());
    }
    response.json({ ok: true });
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
