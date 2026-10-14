import { useCallback, useEffect, useState } from 'react';

import { api } from '../utils/api';

import { SELECT_PROVIDER_EVENT } from './providerSelection';
import { reportProviderProbe } from './providerProbe';
import { readSelectedProviderRaw } from '../utils/selectedProvider';

export {
  CONTINUE_IN_PROVIDER_EVENT,
  SELECT_PROVIDER_EVENT,
  selectChatProvider,
  switchChatProvider,
  type ChatProviderChoice,
} from './providerSelection';

export type CodexUsageWindow = {
  kind: string;
  percent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  expired: boolean;
};

export type CodexAccount = {
  available: boolean;
  email: string | null;
  planType: string | null;
  fetchedAtMs: number | null;
  limits: CodexUsageWindow[];
};

/** Сервер держит ответ две минуты; чаще спрашивать бессмысленно. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Какой помощник выбран сейчас и его смена — для отметки в меню аккаунтов. */
export function useSelectedChatProvider(): string {
  const [provider, setProvider] = useState(() => readSelectedProviderRaw() || 'claude');
  useEffect(() => {
    const onSelect = (event: Event) => setProvider(String((event as CustomEvent).detail || 'claude'));
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'selected-provider') reportProviderProbe('prov-storage', { to: String(event.newValue), was: String(event.oldValue) });
      setProvider(readSelectedProviderRaw() || 'claude');
    };
    window.addEventListener(SELECT_PROVIDER_EVENT, onSelect);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SELECT_PROVIDER_EVENT, onSelect);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return provider;
}

/**
 * Подписка Codex хозяина (GET /api/user/codex-account): почта, тариф, окна
 * 5 ч и неделя. У гостя и без входа — `available: false`, и тогда ни пункта
 * в меню аккаунтов, ни полос в «Расходе» нет.
 */
export function useCodexAccount(): CodexAccount | null {
  const [account, setAccount] = useState<CodexAccount | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.user.codexAccount();
      if (response.ok) {
        setAccount((await response.json()) as CodexAccount);
      }
    } catch {
      // Справочные данные: молча пропускаем, как и лимиты Claude.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return account;
}

