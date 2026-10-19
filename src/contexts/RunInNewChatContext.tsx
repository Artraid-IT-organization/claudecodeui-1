import { createContext, useContext } from 'react';

/*
 * Кнопка «В новый чат» на копируемом блоке (проект «Промпты», 19.10.26):
 * текст блока уходит первым сообщением нового чата ОСНОВНОЙ папки и сразу
 * отправляется — вместо ручного «выделить, скопировать, открыть другой чат,
 * вставить, отправить». `enabled` включается только над лентой чата папки
 * «Промпты»: сама папка и есть признак «это промпт», отдельного
 * классификатора содержимого нет.
 */
type RunInNewChat = {
  enabled: boolean;
  run: (text: string) => void;
};

const RunInNewChatContext = createContext<RunInNewChat>({ enabled: false, run: () => {} });

export const RunInNewChatProvider = RunInNewChatContext.Provider;

export function useRunInNewChat(): RunInNewChat {
  return useContext(RunInNewChatContext);
}
