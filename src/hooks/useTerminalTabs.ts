import { useCallback, useState } from 'react';

/**
 * Открытая командная строка — такая же вкладка наверху, как чат.
 *
 * Егор: «чтобы командная строка открывалась не как отдельная функция, а как
 * дополнительный чат; можно было даже несколько командных строк». Поэтому
 * терминал здесь не режим приложения, а список открытых окон: у каждого свой
 * номер, свой каталог и свой живой сеанс, закрывается крестиком как чат.
 *
 * Список намеренно НЕ переживает перезагрузку страницы, в отличие от вкладок
 * чатов. Чат — это переписка на сервере, её можно открыть заново и увидеть всё
 * как было. Командная строка живёт только пока открыта страница: после
 * перезагрузки это уже другой запущенный процесс, пустой и без истории.
 * Показывать на его месте прежнее имя значило бы обещать то, чего нет, — а
 * заодно на каждом запуске сайта поднимать столько соединений, сколько окон
 * когда-то осталось открытыми.
 */
export type TerminalTab = {
  id: string;
  title: string;
  /** Каталог проекта, в котором окно открылось. */
  projectId?: string;
};

const MAX_TERMINALS = 8;

/** Наименьший свободный номер: закрыли второй из трёх — новый снова второй. */
const nextTitle = (tabs: TerminalTab[]): string => {
  const taken = new Set(
    tabs
      .map((tab) => Number(/^Терминал (\d+)$/.exec(tab.title)?.[1]))
      .filter((value) => Number.isInteger(value)),
  );
  let number = 1;
  while (taken.has(number)) number += 1;
  return `Терминал ${number}`;
};

export function useTerminalTabs(currentProjectId?: string | null) {
  const [terminals, setTerminals] = useState<TerminalTab[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);

  // Новое окно заводится здесь, а не внутри обновления состояния: обновление
  // React может выполнить дважды, и «побочный» выбор активного окна внутри
  // него давал бы то одно окно, то другое.
  const openTerminal = useCallback(() => {
    if (terminals.length >= MAX_TERMINALS) {
      // Больше восьми живых соединений — это уже не работа, а нагрузка на
      // сервер: открываем не новое окно, а последнее из имеющихся.
      setActiveTerminalId(terminals[terminals.length - 1]?.id ?? null);
      return;
    }

    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tab: TerminalTab = {
      id,
      title: nextTitle(terminals),
      projectId: currentProjectId ?? undefined,
    };
    setTerminals((previous) => [...previous, tab]);
    setActiveTerminalId(id);
  }, [currentProjectId, terminals]);

  const focusTerminal = useCallback((id: string) => {
    setActiveTerminalId(id);
  }, []);

  const clearActiveTerminal = useCallback(() => {
    setActiveTerminalId(null);
  }, []);

  const closeTerminal = useCallback(
    (id: string) => {
      const index = terminals.findIndex((tab) => tab.id === id);
      if (index === -1) return;

      setTerminals((previous) => previous.filter((tab) => tab.id !== id));

      if (activeTerminalId === id) {
        // Закрыли то, что смотрели: переходим к соседу справа, иначе слева,
        // иначе обратно в чат — пустого экрана быть не должно.
        const neighbour = terminals[index + 1] ?? terminals[index - 1] ?? null;
        setActiveTerminalId(neighbour ? neighbour.id : null);
      }
    },
    [activeTerminalId, terminals],
  );

  // Перетаскивание окна на новое место среди окон командной строки.
  const moveTerminal = useCallback((id: string, toIndex: number) => {
    setTerminals((previous) => {
      const from = previous.findIndex((tab) => tab.id === id);
      const target = Math.max(0, Math.min(previous.length - 1, toIndex));
      if (from === -1 || from === target) return previous;
      const next = [...previous];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  return {
    terminals,
    moveTerminal,
    activeTerminalId,
    openTerminal,
    focusTerminal,
    closeTerminal,
    clearActiveTerminal,
  };
}
