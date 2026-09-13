import { useEffect, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult, Provider } from '../../types/types';
import type { Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import { isToolGroupItem } from '../../utils/toolGrouping';
import { describeWorkStretch, isMostlyRussian, workStretchRows, type WorkStretchItem } from '../../utils/workStretch';
import { Markdown } from './Markdown';

import MessageComponent from './MessageComponent';
import ToolGroupContainer from './ToolGroupContainer';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface WorkStretchContainerProps {
  stretch: WorkStretchItem;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  getMessageKey: (message: ChatMessage) => string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  selectedProject?: Project | null;
  provider: Provider | string;
}

/** Переводы на время жизни вкладки: повторное раскрытие не ходит на сервер. */
const translatedThoughts = new Map<string, string>();

type TranslationState = 'idle' | 'loading' | 'done' | 'failed';

/**
 * Русский текст ключевых мыслей.
 *
 * Модель размышляет по-английски — так она сильнее (Егор 14.09.26: «пусть
 * Claude размышляет на английском… результаты пусть показываются на русском»).
 * Перевод запрашивается только при раскрытии «Хода работы» и только для
 * нерусских мыслей; сервер переводит каждую один раз. Не вышло — остаётся
 * исходный текст с пометкой: мысль не пропадает.
 */
function useRussianThoughts(thoughts: ChatMessage[], enabled: boolean) {
  const texts = useMemo(() => thoughts.map((message) => String(message.content ?? '')), [thoughts]);
  const pending = useMemo(
    () => texts.filter((text) => !isMostlyRussian(text) && !translatedThoughts.has(text)),
    [texts],
  );
  const [state, setState] = useState<TranslationState>(pending.length > 0 ? 'idle' : 'done');

  useEffect(() => {
    if (!enabled || pending.length === 0) return;
    let cancelled = false;
    setState('loading');
    void (async () => {
      try {
        const response = await api.user.translateThoughts(pending);
        const data = response.ok ? ((await response.json()) as { translations?: Array<string | null> }) : null;
        const translations = data?.translations ?? [];
        let allDone = translations.length === pending.length;
        pending.forEach((text, index) => {
          const translated = translations[index];
          if (typeof translated === 'string' && translated.trim()) {
            translatedThoughts.set(text, translated);
          } else {
            allDone = false;
          }
        });
        if (!cancelled) setState(allDone ? 'done' : 'failed');
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, pending]);

  return {
    state,
    textFor: (message: ChatMessage): { text: string; translated: boolean; original: boolean } => {
      const source = String(message.content ?? '');
      if (isMostlyRussian(source)) return { text: source, translated: false, original: false };
      const translated = translatedThoughts.get(source);
      return translated
        ? { text: translated, translated: true, original: false }
        : { text: source, translated: false, original: true };
    },
  };
}

/**
 * Свёрнутая строка «Ход работы · 3 мысли · 9 действий» между сообщением человека
 * и ответом ИИ — как работа в Claude Code для VS Code и в приложении Claude.
 *
 * По нажатию раскрываются в порядке событий только ключевые размышления
 * (служебные короткие «проверю», «жду» не показываются) — по-русски, переводом —
 * и сделанные шаги одной строкой на действие, с их описанием. Ответ модели стоит
 * ниже целиком: это и есть отчёт.
 */
export default function WorkStretchContainer({
  stretch,
  prevMessage,
  createDiff,
  getMessageKey,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  selectedProject,
  provider,
}: WorkStretchContainerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const label = describeWorkStretch(stretch);

  const rows = useMemo(() => (isExpanded ? workStretchRows(stretch) : []), [isExpanded, stretch]);
  const russian = useRussianThoughts(stretch.keyThoughts, isExpanded);

  return (
    <div className="chat-message tool px-3 sm:px-0" data-message-timestamp={stretch.timestamp || undefined}>
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={isExpanded}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <span className="min-w-0">{label}</span>
      </button>

      {isExpanded && (
        <div className="ml-2 mt-1 space-y-2 border-l border-border/60 pl-3">
          {rows.map((item, index) => {
            if (isToolGroupItem(item)) {
              return (
                <ToolGroupContainer
                  key={`stretch-tools-${getMessageKey(item.messages[0])}`}
                  group={item}
                  prevMessage={prevMessage}
                  createDiff={createDiff}
                  getMessageKey={getMessageKey}
                  onFileOpen={onFileOpen}
                  onShowSettings={onShowSettings}
                  onGrantToolPermission={onGrantToolPermission}
                  showRawParameters={showRawParameters}
                  showThinking={false}
                  selectedProject={selectedProject}
                  provider={provider}
                />
              );
            }
            if (item.isThinking) {
              const shown = russian.textFor(item);
              if (shown.original && russian.state === 'loading') {
                return (
                  <p key={getMessageKey(item)} className="animate-pulse text-[13px] leading-[1.55] text-muted-foreground/70">
                    Перевожу мысль…
                  </p>
                );
              }
              return (
                <div
                  key={getMessageKey(item)}
                  className="prose prose-sm max-w-none text-[13px] leading-[1.55] text-muted-foreground dark:prose-invert"
                  data-thought-translated={shown.translated || undefined}
                >
                  <Markdown>{shown.text}</Markdown>
                  {shown.original && russian.state === 'failed' && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground/60">Перевести не удалось — исходный текст.</p>
                  )}
                </div>
              );
            }
            return (
              <MessageComponent
                key={getMessageKey(item)}
                message={item}
                prevMessage={index > 0 ? null : prevMessage}
                createDiff={createDiff}
                onFileOpen={onFileOpen}
                onShowSettings={onShowSettings}
                onGrantToolPermission={onGrantToolPermission}
                showRawParameters={showRawParameters}
                showThinking={false}
                selectedProject={selectedProject}
                provider={provider}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
