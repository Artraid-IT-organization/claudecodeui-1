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
