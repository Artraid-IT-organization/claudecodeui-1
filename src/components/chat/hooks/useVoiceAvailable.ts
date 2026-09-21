import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { readVoiceConfig, VOICE_CONFIG_SYNC_EVENT } from '../../../hooks/useVoiceConfig';

// Voice UI is gated on the `voiceEnabled` UI preference (toggled in Quick Settings /
// the Settings modal) and a configured voice backend.
const STORAGE_KEY = 'uiPreferences';
const SYNC_EVENT = 'ui-preferences:sync';
let healthRequest: Promise<boolean> | null = null;
// Хук стоит в поле ввода и в кнопке озвучки у КАЖДОГО сообщения. Раньше повтор
// отсекался только пока запрос в полёте, и открытие чата слало проверку голоса
// снова и снова. Готовый ответ держим минуту: настройка голоса на сервере
// меняется раз в жизни, а неудачу не запоминаем, чтобы кнопка ожила сама.
const HEALTH_CACHE_MS = 60_000;
let healthResult: { value: boolean; archived: boolean; at: number } | null = null;

/**
 * Whether the server keeps a copy of this user's recordings (owner only on a
 * shared instance). Read from the last health answer, so it costs nothing at
 * the moment it is needed - when dictation failed and the message on screen
 * must either promise the recording is in Telegram or say nothing of the kind.
 */
export function recordingsAreArchived(): boolean {
  return healthResult?.archived === true;
}

function checkVoiceHealth(): Promise<boolean> {
  if (healthResult && Date.now() - healthResult.at < HEALTH_CACHE_MS) {
    return Promise.resolve(healthResult.value);
  }
  if (healthRequest) return healthRequest;
  const request = authenticatedFetch('/api/voice/health')
    .then(async (response) => {
      if (!response.ok) throw new Error(`Voice health check failed (${response.status})`);
      const data = await response.json();
      const value = data?.configured === true;
      healthResult = { value, archived: data?.archived === true, at: Date.now() };
      return value;
    })
    .finally(() => {
      healthRequest = null;
    });
  healthRequest = request;
  return request;
}

// Matches the `voiceEnabled: true` default in useUiPreferences.ts's DEFAULTS —
// this reads the same localStorage key independently (to avoid a hook
// dependency cycle), so an unset/missing value must fall back the same way,
// not to `false`, or the mic button stays hidden for every user who has
// never opened Settings.
function readVoiceEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    if (parsed?.voiceEnabled === undefined) return true;
    return parsed.voiceEnabled === true || parsed.voiceEnabled === 'true';
  } catch {
    return true;
  }
}

export function useVoiceAvailable(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : readVoiceEnabled(),
  );
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const update = () => setEnabled(readVoiceEnabled());
    window.addEventListener('storage', update);
    window.addEventListener(SYNC_EVENT, update as EventListener);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener(SYNC_EVENT, update as EventListener);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const check = async () => {
      if (!enabled) {
        setAvailable(false);
        return;
      }
      if (readVoiceConfig().baseUrl.trim()) {
        setAvailable(true);
        return;
      }
      const id = ++requestId;
      try {
        const result = await checkVoiceHealth();
        if (active && id === requestId) setAvailable(result);
      } catch {
        if (active && id === requestId) setAvailable(false);
      }
    };

    void check();
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    return () => {
      active = false;
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    };
  }, [enabled]);

  return enabled && available;
}
