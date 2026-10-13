import { useCallback, useEffect, useState } from 'react';

import { api } from '../utils/api';

export type DevinUsageWindow = {
  /** `daily` = дневная квота, `weekly` = недельная. Пятичасового окна у Devin нет. */
  kind: string;
  /** Процент окна, уже израсходованный (сервер переворачивает remaining из API). */
  percent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  expired: boolean;
};

export type DevinAccount = {
  available: boolean;
  email: string | null;
  planName: string | null;
  fetchedAtMs: number | null;
  limits: DevinUsageWindow[];
};

/** Сервер держит ответ минуту; панель опрашивает реже. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Подписка Devin хозяина (GET /api/user/devin-account): почта, тариф, дневное
 * и недельное окна квоты. У гостя и без машинной креды — `available: false`,
 * и тогда полос в «Расходе» нет.
 */
export function useDevinAccount(): DevinAccount | null {
  const [account, setAccount] = useState<DevinAccount | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.user.devinAccount();
      if (response.ok) {
        setAccount((await response.json()) as DevinAccount);
      }
    } catch {
      // Справочные данные: молча пропускаем, как и лимиты остальных провайдеров.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return account;
}
