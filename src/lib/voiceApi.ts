import { authenticatedFetch } from '../utils/api';
import { readVoiceConfig, voiceConfigHeaders } from '../hooks/useVoiceConfig';

import type { VoiceTarget } from './voiceDelivery';

/**
 * Контекст записи для сервера: номер для дедупа повторов и адресат текста,
 * чтобы сервер держал расшифровку, пока клиент не подтвердит доставку в чат.
 */
export type VoiceTranscribeMeta = VoiceTarget & {
  recId?: string | null;
  send?: boolean;
};

function appendMeta(body: FormData, meta?: VoiceTranscribeMeta): void {
  if (!meta) return;
  if (meta.recId) body.append('clientRecId', meta.recId);
  if (meta.sessionId) body.append('targetSession', meta.sessionId);
  if (meta.scope) body.append('targetScope', meta.scope);
  if (meta.send) body.append('sendIntent', '1');
}

function directUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
}

export function transcribeVoice(blob: Blob, filename: string, signal?: AbortSignal, meta?: VoiceTranscribeMeta): Promise<Response> {
  const config = readVoiceConfig();
  const body = new FormData();

  if (config.baseUrl.trim()) {
    body.append('file', blob, filename);
    body.append('model', config.sttModel || 'whisper-1');
    // Свой бэкенд метаданные не разбирает — но и ломать их ему нечем.
    appendMeta(body, meta);
    return fetch(directUrl(config.baseUrl.trim(), '/audio/transcriptions'), {
      method: 'POST',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      body,
      signal,
    });
  }

  body.append('audio', blob, filename);
  appendMeta(body, meta);
  return authenticatedFetch('/api/voice/transcribe', {
    method: 'POST',
    headers: voiceConfigHeaders(),
    body,
    signal,
  });
}

/**
 * Потоковая диктовка кусками (27.10.26): кусок записи уходит на сервер прямо
 * во время диктовки отдельным POST — после отпускания остаётся только
 * распознавание, дорога файла не добавляется к ожиданию. Живёт только на
 * нашем сервере: при настроенном своём бэкенде включается обычный путь.
 */
export function voiceStreamingAvailable(): boolean {
  return !readVoiceConfig().baseUrl.trim();
}

/** Один кусок записи. Клиент обязан слать их строго последовательно. */
export function voiceStreamChunk(sid: string, chunk: Blob): Promise<Response> {
  return authenticatedFetch(`/api/voice/stream-chunk?sid=${encodeURIComponent(sid)}`, {
    method: 'POST',
    headers: { 'Content-Type': chunk.type || 'audio/webm' },
    body: chunk,
  });
}

/** Завершение потока: сервер склеивает куски и распознаёт. Ответ — как у transcribe. */
export function voiceStreamFinish(sid: string, meta?: VoiceTranscribeMeta, signal?: AbortSignal): Promise<Response> {
  return authenticatedFetch('/api/voice/stream-finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...voiceConfigHeaders() },
    body: JSON.stringify({
      sid,
      ...(meta?.recId ? { clientRecId: meta.recId } : {}),
      ...(meta?.sessionId ? { targetSession: meta.sessionId } : {}),
      ...(meta?.scope ? { targetScope: meta.scope } : {}),
      ...(meta?.send ? { sendIntent: '1' } : {}),
    }),
    signal,
  });
}

/** Освобождает недоеденную сессию на сервере (запись отменена/страница ушла). */
export function voiceStreamAbort(sid: string): void {
  void authenticatedFetch('/api/voice/stream-abort', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid }),
    keepalive: true,
  }).catch(() => undefined);
}

export function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  const config = readVoiceConfig();

  if (config.baseUrl.trim()) {
    return fetch(directUrl(config.baseUrl.trim(), '/audio/speech'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel || 'tts-1',
        voice: config.ttsVoice || 'alloy',
        input: text,
        ...(config.ttsFormat.trim() ? { response_format: config.ttsFormat.trim() } : {}),
      }),
      signal,
    });
  }

  return authenticatedFetch('/api/voice/tts', {
    method: 'POST',
    body: JSON.stringify({ text }),
    headers: voiceConfigHeaders(),
    signal,
  });
}
