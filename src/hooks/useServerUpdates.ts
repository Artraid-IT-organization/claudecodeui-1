import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

/**
 * Опрос плашки «Обновить»: на сервере ждёт пул изменений с другого сервера.
 *
 * Состояние рождается не здесь и не в запросе: сторож установки
 * (deploy/selfhost/check-updates.sh) раз в ~30 минут сверяет версию с
 * источником и пишет файл, а /api/updates/status его только читает — поэтому
 * опрашивать можно часто, это чтение файла, а не git fetch.
 */
export type ServerUpdateCommit = { sha: string; subject: string; date: string; author: string };
export type ServerUpdatePending = {
  id: string;
  label: string;
  remote: string;
  base: string;
  commits: ServerUpdateCommit[];
  filesChanged: number;
  diffStat: string;
  conflict: { kind: string; total?: number; items: Array<{ path: string; note: string }> } | null;
  checkedAt: string;
};
export type ServerUpdateApply = {
  id: string;
  state: 'running' | 'ok' | 'failed';
  finishedAt?: string;
  detail?: string;
};
export type ServerUpdateStatus = {
  pending: ServerUpdatePending | null;
  dismissed: { id: string; commits: number } | null;
  applying: ServerUpdateApply | null;
  lastResult: ServerUpdateApply | null;
  configured: boolean;
};

const EMPTY: ServerUpdateStatus = {
  pending: null,
  dismissed: null,
  applying: null,
  lastResult: null,
  configured: false,
};

const POLL_MS = 60_000;
/** При идущей установке опрашиваем чаще — человек смотрит на прогресс. */
const APPLYING_POLL_MS = 10_000;

export function useServerUpdates() {
  const [status, setStatus] = useState<ServerUpdateStatus>(EMPTY);
  const statusRef = useRef(status);
  statusRef.current = status;

  const refresh = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/updates/status');
      if (!response.ok) return;
      const body = await response.json().catch(() => null);
      if (body?.data && typeof body.data === 'object') {
        setStatus(body.data as ServerUpdateStatus);
      }
    } catch {
      // Сеть мигнула — просто покажем прежнее состояние до следующего опроса.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      await refresh();
      if (cancelled) return;
      timer = window.setTimeout(tick, statusRef.current.applying ? APPLYING_POLL_MS : POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { status, refresh };
}
