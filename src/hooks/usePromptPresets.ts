import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

/**
 * Пресет промпта: сохранённая заготовка «системного» промпта для новой роли.
 *
 * Держим один общий хук на всё приложение: список читается один раз при
 * входе, дальше локальные правки — оптимистически, с фолбэком на повторный
 * fetch при ошибке сервера. Так шапка разговора и настройки не расходятся.
 */
export type PromptPreset = {
  id: number;
  name: string;
  systemPrompt: string;
  defaultModel: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type PresetInput = {
  name: string;
  systemPrompt: string;
  defaultModel?: string | null;
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
  if (!response.ok) {
    const message = json?.error || `Сервер ответил ${response.status}`;
    throw new Error(message);
  }
  return json;
}

const STORAGE_KEY = 'active-prompt-preset-id';

function readActiveId(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeActiveId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    // хранилище недоступно — активный пресет просто не переживёт перезагрузку
  }
}

export function usePromptPresets() {
  const [presets, setPresets] = useState<PromptPreset[]>([]);
  const [activeId, setActiveIdState] = useState<number | null>(readActiveId);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/prompt-presets');
      const json = await assertOk(response);
      const next: PromptPreset[] = Array.isArray(json?.presets) ? json.presets : [];
      setPresets(next);
    } catch (err: any) {
      setError(err?.message || 'Не удалось прочитать пресеты');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setActiveId = useCallback((id: number | null) => {
    setActiveIdState(id);
    writeActiveId(id);
  }, []);

  const create = useCallback(async (input: PresetInput) => {
    const response = await authenticatedFetch('/api/prompt-presets', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const json = await assertOk(response);
    const preset = json?.preset as PromptPreset;
    setPresets((prev) => [...prev, preset]);
    return preset;
  }, []);

  const update = useCallback(
    async (id: number, patch: Partial<PresetInput>) => {
      const response = await authenticatedFetch(`/api/prompt-presets/${id}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      const json = await assertOk(response);
      const preset = json?.preset as PromptPreset;
      setPresets((prev) => prev.map((item) => (item.id === id ? preset : item)));
      return preset;
    },
    [],
  );

  const remove = useCallback(
    async (id: number) => {
      const response = await authenticatedFetch(`/api/prompt-presets/${id}`, { method: 'DELETE' });
      await assertOk(response);
      setPresets((prev) => prev.filter((item) => item.id !== id));
      if (activeId === id) setActiveId(null);
    },
    [activeId, setActiveId],
  );

  const reorder = useCallback(async (orderedIds: number[]) => {
    const response = await authenticatedFetch('/api/prompt-presets/order/all', {
      method: 'PUT',
      body: JSON.stringify({ ids: orderedIds }),
    });
    const json = await assertOk(response);
    const next: PromptPreset[] = Array.isArray(json?.presets) ? json.presets : [];
    setPresets(next);
  }, []);

  const activePreset = activeId ? presets.find((preset) => preset.id === activeId) ?? null : null;

  return {
    presets,
    activePreset,
    activeId,
    setActiveId,
    isLoading,
    error,
    refresh,
    create,
    update,
    remove,
    reorder,
  };
}
