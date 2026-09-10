import { Terminal, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cn } from '../../lib/utils';
import LLMProviderLogo from '../llm-provider-logo/LLMProviderLogo';
import type { OpenSessionTab } from '../../hooks/useOpenSessionTabs';
import type { TerminalTab } from '../../hooks/useTerminalTabs';

type SessionTabsBarProps = {
  tabs: OpenSessionTab[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  /** Открытые окна командной строки — такие же вкладки, как чаты. */
  terminals?: TerminalTab[];
  activeTerminalId?: string | null;
  onSelectTerminal?: (id: string) => void;
  onCloseTerminal?: (id: string) => void;
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
  terminals = [],
  activeTerminalId = null,
  onSelectTerminal,
  onCloseTerminal,
}: SessionTabsBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const activeTabElement = scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    activeTabElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    // `tabs` (not just activeSessionId) is a real dependency here: opening a
    // session that isn't an existing tab yet adds it to `tabs` one render
    // after activeSessionId changes (see useOpenSessionTabs - the tab-adding
    // effect and this one both key off activeSessionId, but React commits
    // that render before either effect runs, so the querySelector above finds
    // nothing on the render where activeSessionId first changes). Without
    // `tabs` here, that first (and only) run finds no match and this effect
    // never re-fires once the tab actually exists in the DOM - the active
    // tab silently stays off-screen with no scrollbar to reveal it.
  }, [activeSessionId, tabs, activeTerminalId, terminals]);

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

        return (
          <div
            key={tab.sessionId}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            title={tab.title}
            onClick={() => onSelect(tab.sessionId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(tab.sessionId);
              }
            }}
            className={cn(
              'group relative flex min-w-[108px] max-w-[220px] flex-shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/40 px-2.5 py-2 text-xs transition-colors sm:min-w-[140px] sm:text-sm',
              isActive
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            <LLMProviderLogo provider={tab.provider} className="h-3.5 w-3.5 flex-shrink-0" />
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
            onClick={() => onSelectTerminal?.(term.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectTerminal?.(term.id);
              }
            }}
            className={cn(
              'group relative flex min-w-[108px] max-w-[220px] flex-shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/40 px-2.5 py-2 text-xs transition-colors sm:min-w-[140px] sm:text-sm',
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
