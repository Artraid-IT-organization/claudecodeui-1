import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

/**
 * Снимки состояния проекта — «кнопка отмены» для работы агента.
 *
 * Хук отвечает за чтение списка и откат. Сами снимки делает сервер, перед
 * каждым изменяющим действием агента; клиент их только показывает.
 */
export type Checkpoint = {
  id: string;
  label: string;
  tool: string | null;
  file: string | null;
  sessionId: string | null;
  createdAt: string;
};

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function assertOk(response: Response): Promise<any> {
  const json = await readJson(response);
  if (!response.ok) throw new Error(json?.error || `Сервер ответил ${response.status}`);
  return json;
}

export function useCheckpoints(projectPath: string | null, sessionId: string | null) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setCheckpoints([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ projectPath });
      if (sessionId) params.set('sessionId', sessionId);
      const response = await authenticatedFetch(`/api/checkpoints?${params.toString()}`);
      const json = await assertOk(response);
      setCheckpoints(Array.isArray(json?.checkpoints) ? json.checkpoints : []);
    } catch (err: any) {
      setError(err?.message || 'Не удалось прочитать снимки');
      setCheckpoints([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Какие файлы изменятся при откате — показываем до нажатия. */
  const preview = useCallback(
    async (checkpointId: string): Promise<string[]> => {
      if (!projectPath) return [];
      const params = new URLSearchParams({ projectPath });
      const response = await authenticatedFetch(
        `/api/checkpoints/${checkpointId}/preview?${params.toString()}`,
      );
      const json = await assertOk(response);
      return Array.isArray(json?.files) ? json.files : [];
    },
    [projectPath],
  );

  const restore = useCallback(
    async (checkpointId: string): Promise<{ restored: string[] }> => {
      if (!projectPath) throw new Error('проект не выбран');
      const response = await authenticatedFetch(`/api/checkpoints/${checkpointId}/restore`, {
        method: 'POST',
        body: JSON.stringify({ projectPath, sessionId }),
      });
      const json = await assertOk(response);
      // После отката появляется страховочный снимок — список надо перечитать.
      void refresh();
      return { restored: Array.isArray(json?.restored) ? json.restored : [] };
    },
    [projectPath, sessionId, refresh],
  );

  return { checkpoints, isLoading, error, refresh, preview, restore };
}
