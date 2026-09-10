import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { usePromptPresets, type PromptPreset } from '../hooks/usePromptPresets';

/**
 * Контекст пресетов промптов на всё приложение.
 *
 * Держим один общий список, чтобы шапка разговора (переключатель) и настройки
 * (редактор списка) видели одно и то же и не расходились. Хук
 * `usePromptPresets` реально грузит и правит список, а этот контекст его
 * раздаёт.
 */
type PromptPresetsContextValue = ReturnType<typeof usePromptPresets>;

const PromptPresetsContext = createContext<PromptPresetsContextValue | null>(null);

export function PromptPresetsProvider({ children }: { children: ReactNode }) {
  const value = usePromptPresets();
  const stable = useMemo(() => value, [value]);
  return (
    <PromptPresetsContext.Provider value={stable}>{children}</PromptPresetsContext.Provider>
  );
}

export function usePromptPresetsContext(): PromptPresetsContextValue {
  const value = useContext(PromptPresetsContext);
  if (!value) {
    throw new Error('usePromptPresetsContext вызвали вне PromptPresetsProvider');
  }
  return value;
}
