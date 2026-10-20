import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

import { SELECT_PROVIDER_EVENT, readSelectedDevinConnectionId } from './providerSelection';

export { readSelectedDevinConnectionId, selectDevinConnection } from './providerSelection';

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
