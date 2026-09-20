import { useCallback, useSyncExternalStore } from 'react';

/*
 * Какой блок верхней панели открыт: «Проекты» (этот сервер) или второй
 * сервер. Егор 20.09.26: «есть проекты, а есть проекты 2 сервера; если я
 * захожу туда, открывается новый чат, который не мешается с проектами
 * обычного чата, и последние открытые чаты — отдельный список».
 *
 * Выбор живёт здесь, а не в состоянии панели: его спрашивают и шапка
 * (какая кнопка нажата), и список папок, и лента последних чатов, и
 * создание нового чата. Помнится устройством — вернувшись, человек
 * попадает в тот же блок, из которого ушёл.
 */
export type ServerScope = 'main' | 'second';

const STORAGE_KEY = 'sidebar-server-scope';
const listeners = new Set<() => void>();

function read(): ServerScope {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'second' ? 'second' : 'main';
  } catch {
    return 'main';
  }
}

let current: ServerScope = typeof window === 'undefined' ? 'main' : read();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useServerScope(): [ServerScope, (next: ServerScope) => void] {
  const scope = useSyncExternalStore(subscribe, () => current, () => 'main' as ServerScope);
  const setScope = useCallback((next: ServerScope) => {
    if (next === current) return;
    current = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Приватный режим Safari — выбор просто не запомнится.
    }
    listeners.forEach((listener) => listener());
  }, []);
  return [scope, setScope];
}

/** Блок, которому принадлежит чат: своё значение важнее значения папки. */
export function effectiveScope(
  sessionScope: ServerScope | null | undefined,
  projectScope: ServerScope | null | undefined,
): ServerScope {
  return sessionScope ?? projectScope ?? 'main';
}

/*
 * Название второго блока (SECOND_SERVER_LABEL на сервере, у общей площадки —
 * только хозяину). Лежит здесь же, а не ходит пропсами: его спрашивают шапка,
 * карточка чата и карточка папки — три конца панели, между которыми иначе
 * пришлось бы тянуть проп через четыре компонента.
 */
let secondServerLabel: string | null = null;
const labelListeners = new Set<() => void>();

function subscribeLabel(listener: () => void) {
  labelListeners.add(listener);
  return () => {
    labelListeners.delete(listener);
  };
}

export function setSecondServerLabel(next: string | null) {
  const normalized = next && next.trim().length > 0 ? next.trim() : null;
  if (normalized === secondServerLabel) return;
  secondServerLabel = normalized;
  labelListeners.forEach((listener) => listener());
}

export function useSecondServerLabel(): string | null {
  return useSyncExternalStore(subscribeLabel, () => secondServerLabel, () => null);
}
