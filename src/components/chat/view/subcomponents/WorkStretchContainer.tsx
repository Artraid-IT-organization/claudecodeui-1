import { useEffect, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult, Provider } from '../../types/types';
import type { Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import { isToolGroupItem } from '../../utils/toolGrouping';
import { describeWorkStretch, workStretchRows, type WorkStretchItem } from '../../utils/workStretch';
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

type ThoughtDigest = { keep: boolean; ru: string | null };
type DigestState = 'idle' | 'loading' | 'done' | 'failed';

/** Итоги разбора на время жизни вкладки: повторное раскрытие не ходит на сервер. */
const digestByText = new Map<string, ThoughtDigest>();
/** Столько мыслей уходит на сервер за один запрос (там же и потолок). */
const DIGEST_PAGE_SIZE = 60;

/**
 * Какие мысли — важные этапы, и их русский текст.
 *
 * Модель размышляет по-английски — так она сильнее. Показ отбирает этапы
 * (закончено исследование, запущена критика, вывод, решение) и переводит их;
 * рабочие мелочи не показывает. Потолка по числу нет: долгая работа — много
 * этапов (Егор 14.09.26). Разбор запрашивается только при раскрытии. Не вышло
 * — видны все мысли как есть с пометкой: ничего не пропадает.
 */
function useThoughtDigest(thoughts: ChatMessage[], enabled: boolean) {
  const texts = useMemo(() => thoughts.map((message) => String(message.content ?? '')), [thoughts]);
  const [state, setState] = useState<DigestState>('idle');
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const missing = [...new Set(texts.filter((text) => !digestByText.has(text)))];
    if (missing.length === 0) {
      setState('done');
      return;
    }
    let cancelled = false;
    setState('loading');
    void (async () => {
      let failed = false;
      for (let start = 0; start < missing.length; start += DIGEST_PAGE_SIZE) {
        const page = missing.slice(start, start + DIGEST_PAGE_SIZE);
        try {
          const response = await api.user.thoughtDigest(page);
          const data = response.ok ? ((await response.json()) as { items?: Array<ThoughtDigest | null> }) : null;
          const items = data?.items ?? [];
          page.forEach((text, index) => {
            const item = items[index];
            if (item && typeof item.keep === 'boolean') {
              digestByText.set(text, { keep: item.keep, ru: typeof item.ru === 'string' ? item.ru : null });
            } else {
              failed = true;
            }
          });
        } catch {
          failed = true;
        }
        if (cancelled) return;
        // Долгая работа разбирается страницами — этапы появляются по мере готовности.
        setVersion((value) => value + 1);
      }
      if (!cancelled) setState(failed ? 'failed' : 'done');
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, texts]);

  const known = thoughts.every((message) => digestByText.has(String(message.content ?? '')));
  const shown = new Set<ChatMessage>();
  for (const message of thoughts) {
    const digest = digestByText.get(String(message.content ?? ''));
    if (digest ? digest.keep : state === 'failed') shown.add(message);
  }

  return {
    state,
    shown,
    stageCount: known ? shown.size : undefined,
    textFor: (message: ChatMessage): string => {
      const digest = digestByText.get(String(message.content ?? ''));
      return digest?.keep && digest.ru ? digest.ru : String(message.content ?? '');
    },
  };
}

/**
 * Свёрнутая строка «Ход работы · 5 этапов · 9 действий» между сообщением
 * человека и ответом ИИ — как работа в Claude Code для VS Code и в приложении
 * Claude.
 *
 * По нажатию раскрываются в порядке событий важные этапы размышлений — все, по
 * -русски — и сделанные шаги одной строкой на действие, с их описанием. Ответ
 * модели стоит ниже целиком: это и есть отчёт.
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
  const digest = useThoughtDigest(stretch.thoughts, isExpanded);
  const label = describeWorkStretch({
    actionCount: stretch.actionCount,
    errorCount: stretch.errorCount,
    stageCount: digest.stageCount,
    hasThoughts: stretch.thoughts.length > 0,
  });

  const rows = isExpanded ? workStretchRows(stretch, digest.shown) : [];
  const hasThoughts = stretch.thoughts.length > 0;

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
          {hasThoughts && digest.state === 'loading' && (
            <p className="animate-pulse text-[12px] text-muted-foreground/70">Отбираю важные этапы размышлений…</p>
          )}
          {hasThoughts && digest.state === 'failed' && (
            <p className="text-[11px] text-muted-foreground/60">Отобрать важное не удалось — мысли показаны как есть.</p>
          )}
          {rows.length === 0 && digest.state === 'done' && (
            <p className="text-[12px] text-muted-foreground/70">Важных этапов в размышлениях нет.</p>
          )}
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
              return (
                <div
                  key={getMessageKey(item)}
                  className="prose prose-sm max-w-none text-[13px] leading-[1.55] text-muted-foreground dark:prose-invert"
                  data-thought-stage
                >
                  <Markdown>{digest.textFor(item)}</Markdown>
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
