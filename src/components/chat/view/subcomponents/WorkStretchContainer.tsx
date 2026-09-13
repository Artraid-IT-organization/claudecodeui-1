import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult, Provider } from '../../types/types';
import type { Project } from '../../../../types/app';
import { groupConsecutiveTools, isToolGroupItem } from '../../utils/toolGrouping';
import { describeWorkStretch, isKeyThought, type WorkStretchItem } from '../../utils/workStretch';
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

/**
 * Свёрнутая строка «Ход работы · 3 мысли · 9 действий» между сообщением человека
 * и ответом ИИ — как работа в Claude Code для VS Code и в приложении Claude.
 *
 * По нажатию раскрываются в порядке событий только ключевые размышления
 * (служебные короткие «проверю», «жду» не показываются) и сделанные шаги —
 * одной строкой на действие, с их описанием. Ответ модели стоит ниже целиком:
 * это и есть отчёт.
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

  const rows = useMemo(() => {
    if (!isExpanded) return [];
    // Внутри — только ключевые мысли и действия; пустые и служебные мысли
    // отбрасываются, подряд идущие одинаковые действия склеиваются в одну строку.
    const visible = stretch.messages.filter((message) => !message.isThinking || isKeyThought(message));
    return groupConsecutiveTools(visible, false);
  }, [isExpanded, stretch.messages]);

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
              return (
                <div
                  key={getMessageKey(item)}
                  className="prose prose-sm max-w-none text-[13px] leading-[1.55] text-muted-foreground dark:prose-invert"
                >
                  <Markdown>{String(item.content ?? '')}</Markdown>
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
