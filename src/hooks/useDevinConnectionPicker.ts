import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

import { SELECT_PROVIDER_EVENT, selectChatProvider } from './useCodexAccount';

/** Канал Devin из реестра сервера (GET /api/providers/devin/connections), поля для пикера. */
export type DevinConnectionOption = {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  health: string;
  cooldownUntil: string | null;
  accountEmail: string | null;
};

/**
 * localStorage-ключ подписки, выбранной в пикере; уходит серверу с каждым
 * ходом Devin — и в новом чате, и в открытом (история чата живёт в его линии,
 * платить за ход может любая подписка: devin-connections.service).
 */
const SELECTED_DEVIN_CONNECTION_KEY = 'selected-devin-connection';

/** Выбрать канал Devin для новых чатов: запоминает его и переключает помощника на Devin. */
export function selectDevinConnection(connectionId: number): void {
  localStorage.setItem(SELECTED_DEVIN_CONNECTION_KEY, String(connectionId));
  selectChatProvider('devin');
}

/** Канал, выбранный в пикере; null — сервер выбирает сам (первый годный по приоритету). */
export function readSelectedDevinConnectionId(): number | null {
  const id = Number(localStorage.getItem(SELECTED_DEVIN_CONNECTION_KEY));
  return id > 0 ? id : null;
}

/** Реактивная версия readSelectedDevinConnectionId для отметки в меню. */
export function useSelectedDevinConnectionId(): number | null {
  const [id, setId] = useState<number | null>(readSelectedDevinConnectionId);
  useEffect(() => {
    const onChange = () => setId(readSelectedDevinConnectionId());
    window.addEventListener(SELECT_PROVIDER_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(SELECT_PROVIDER_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return id;
}

/**
 * Включённые каналы Devin для пикера. Эндпоинт админки отвечает 403 всем, кроме
 * владельца площадки — для них список пуст и пункты Devin в меню не появляются.
 */
export function useDevinConnections(): { connections: DevinConnectionOption[]; reload: () => Promise<void> } {
  const [connections, setConnections] = useState<DevinConnectionOption[]>([]);

  const reload = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/providers/devin/connections');
      if (!response.ok) {
        setConnections([]);
        return;
      }
      const body = (await response.json()) as { data?: { connections?: DevinConnectionOption[] } };
      setConnections((body.data?.connections ?? []).filter((connection) => connection.enabled));
    } catch {
      setConnections([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { connections, reload };
}
