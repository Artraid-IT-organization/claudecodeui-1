import { useCallback, useSyncExternalStore } from 'react';

/*
 * Вид списка чатов: «Группы» — чаты по делам, внизу по дням то, что в группу
 * не попало; «Последние» — все чаты подряд по дням, без групп. Егор 16.09.26:
 * «чтобы я мог легко переключить — посмотреть последние чаты, а могу
 * посмотреть в группах»; кнопка — в строке «Проекты / архив», а не отдельной
 * строкой под «Новым сеансом». Кнопка и список — разные компоненты, поэтому
 * выбор хранится здесь и помнится устройством.
 */
export type SessionListView = 'groups' | 'recent';

const STORAGE_KEY = 'sidebar-session-list-view';
const listeners = new Set<() => void>();

function read(): SessionListView {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'recent' ? 'recent' : 'groups';
  } catch {
    return 'groups';
  }
}

let current: SessionListView = typeof window === 'undefined' ? 'groups' : read();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionListView(): [SessionListView, (next: SessionListView) => void] {
  const view = useSyncExternalStore(subscribe, () => current, () => 'groups' as SessionListView);
  const setView = useCallback((next: SessionListView) => {
    current = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Приватный режим Safari — выбор просто не запомнится.
    }
    listeners.forEach((listener) => listener());
  }, []);
  return [view, setView];
}
