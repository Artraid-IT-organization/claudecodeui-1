import { Terminal, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cn } from '../../lib/utils';
import { useTabReorderDrag } from './useTabReorderDrag';
import LLMProviderLogo from '../llm-provider-logo/LLMProviderLogo';
import type { OpenSessionTab } from '../../hooks/useOpenSessionTabs';
import type { TerminalTab } from '../../hooks/useTerminalTabs';
import type { SessionActivityMap } from '../../hooks/useSessionProtection';
import { PHASE_ICONS, PHASE_SHORT_LABELS, PHASE_TONES } from '../chat/utils/activityPhaseStyle';

type SessionTabsBarProps = {
  tabs: OpenSessionTab[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  /** Перетаскивание вкладки чата на новое место (индекс среди вкладок чатов). */
  onReorder?: (sessionId: string, toIndex: number) => void;
  /** Открытые окна командной строки — такие же вкладки, как чаты. */
  terminals?: TerminalTab[];
  activeTerminalId?: string | null;
  onSelectTerminal?: (id: string) => void;
  onCloseTerminal?: (id: string) => void;
  /** Перетаскивание окна командной строки на новое место среди окон. */
  onReorderTerminal?: (id: string, toIndex: number) => void;
  /**
   * Чем сейчас занят каждый чат. Вкладка работающего чата показывает значок
   * фазы вместо значка Claude — видно, какой из открытых чатов думает, не
   * переключаясь на него.
   */
  activities?: SessionActivityMap;
};

/**
 * Horizontal strip of open-session tabs, rendered above the Chat/Shell/Files/
 * Source Control switcher (see `MainContentHeader`). Mirrors the open-editor
 * tabs in VS Code's Claude Code extension: click to switch instantly without
 * a trip to the sidebar, click the "x" to close.
 */
export default function SessionTabsBar({
  tabs,
  activeSessionId,
  onSelect,
  onClose,
  onReorder,
  terminals = [],
  activeTerminalId = null,
  onSelectTerminal,
  onCloseTerminal,
  onReorderTerminal,
  activities,
}: SessionTabsBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledToKeyRef = useRef<string | null>(null);

  // Докрутка к активной вкладке — ОДИН раз на смену активной вкладки.
  // Раньше эффект зависел от массивов `tabs`/`terminals`, а `openTabs`
  // пересобирается `.map()` на каждой перерисовке AppContent (а та идёт на
  // каждое сообщение сокета, пока любой чат работает). Итог — полоса,
  // пролистанная пальцем, через долю секунды уезжала обратно к активной
  // вкладке (Егор 15.09.26: «листаю — возвращается в исходную позицию»).
  // Зависимости — строки, а не массивы: перерисовка без смены состава их не
  // меняет. Состав вкладок в зависимостях остаётся по старой причине:
  // вкладка только что открытого чата появляется на рендер позже, чем
  // activeSessionId, и первый проход её ещё не находит — тогда ключ не
  // запоминается и докрутка случится, когда вкладка появится.
  const activeKey = activeTerminalId !== null ? `term:${activeTerminalId}` : `chat:${activeSessionId ?? ''}`;
  const tabIdsKey = tabs.map((tab) => tab.sessionId).join('|');
  const terminalIdsKey = terminals.map((term) => term.id).join('|');

  useEffect(() => {
    if (scrolledToKeyRef.current === activeKey) return;
    const activeTabElement = scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!activeTabElement) return;
    scrolledToKeyRef.current = activeKey;
    activeTabElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [activeKey, tabIdsKey, terminalIdsKey]);

  useTabReorderDrag({
    containerRef: scrollRef,
    itemIds: [...tabs.map((tab) => tab.sessionId), ...terminals.map((term) => term.id)],
    onReorder: onReorder || onReorderTerminal
      ? (id, toIndex, group) => (group === 'terminal' ? onReorderTerminal : onReorder)?.(id, toIndex)
      : undefined,
  });

  if (tabs.length === 0 && terminals.length === 0) {
    return null;
  }

  return (
    <div
      ref={scrollRef}
      role="tablist"
      aria-label="Open sessions"
      className="scrollbar-hide flex flex-shrink-0 items-stretch overflow-x-auto border-b border-border/60 bg-muted/30 [-webkit-overflow-scrolling:touch]"
    >
      {tabs.map((tab) => {
        const isActive = activeTerminalId === null && tab.sessionId === activeSessionId;
        const activity = activities?.get(tab.sessionId) ?? null;
        const phaseKey = activity ? (activity.phase ?? 'waiting') : null;
        const PhaseIcon = phaseKey ? PHASE_ICONS[phaseKey] : null;
        const phaseLabel = phaseKey ? PHASE_SHORT_LABELS[phaseKey] ?? 'Работает' : null;

        return (
          <div
            key={tab.sessionId}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            title={phaseLabel ? `${tab.title} — ${phaseLabel}…` : tab.title}
            data-phase={phaseKey ?? 'idle'}
            data-reorder-id={tab.sessionId}
            data-reorder-group="chat"
            onClick={() => onSelect(tab.sessionId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(tab.sessionId);
              }
            }}
            className={cn(
              'group relative flex min-w-[108px] max-w-[220px] flex-shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border/40 px-2.5 py-2 text-xs transition-colors [-webkit-touch-callout:none] sm:min-w-[140px] sm:text-sm',
              'data-[dragging=true]:cursor-grabbing data-[dragging=true]:bg-background data-[dragging=true]:text-foreground data-[dragging=true]:shadow-[0_6px_20px_rgba(0,0,0,0.35)] data-[dragging=true]:ring-1 data-[dragging=true]:ring-border',
              isActive
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            {PhaseIcon && phaseKey ? (
              <PhaseIcon
                className={cn('h-3.5 w-3.5 flex-shrink-0 animate-pulse', PHASE_TONES[phaseKey])}
                aria-label={phaseLabel ?? undefined}
              />
            ) : (
              <LLMProviderLogo provider={tab.provider} className="h-3.5 w-3.5 flex-shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{tab.title}</span>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.sessionId);
              }}
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded opacity-100 hover:bg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:opacity-0 sm:group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
            {isActive && <div className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
          </div>
        );
      })}

      {terminals.map((term) => {
        const isActive = term.id === activeTerminalId;

        return (
          <div
            key={term.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            title={term.title}
            data-reorder-id={term.id}
            data-reorder-group="terminal"
            onClick={() => onSelectTerminal?.(term.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectTerminal?.(term.id);
              }
            }}
            className={cn(
              'group relative flex min-w-[108px] max-w-[220px] flex-shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border/40 px-2.5 py-2 text-xs transition-colors [-webkit-touch-callout:none] sm:min-w-[140px] sm:text-sm',
              'data-[dragging=true]:cursor-grabbing data-[dragging=true]:bg-background data-[dragging=true]:text-foreground data-[dragging=true]:shadow-[0_6px_20px_rgba(0,0,0,0.35)] data-[dragging=true]:ring-1 data-[dragging=true]:ring-border',
              isActive
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            <Terminal className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate">{term.title}</span>
            <button
              type="button"
              aria-label={`Закрыть ${term.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTerminal?.(term.id);
              }}
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded opacity-100 hover:bg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 sm:opacity-0 sm:group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
            {isActive && <div className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />}
          </div>
        );
      })}
    </div>
  );
}
