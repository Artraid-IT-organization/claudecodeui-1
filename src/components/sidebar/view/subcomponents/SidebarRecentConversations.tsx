import { MessageSquare } from 'lucide-react';
import { useMemo } from 'react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { LLMProvider, Project, ProjectSession } from '../../../../types/app';
import type { RecentConversationListItem, SessionWithProvider } from '../../types/types';
import { groupByRecency } from '../../utils/utils';

import SidebarSessionItem from './SidebarSessionItem';

type SidebarRecentConversationsProps = {
  conversations: RecentConversationListItem[];
  /** Все папки выбранного блока — по projectId строки находится её проект. */
  projects: Project[];
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasError: boolean;
  selectedSession: ProjectSession | null;
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  /** Служебные чаты (auto-запуски, «Промпты») скрыты; кнопка их возвращает. */
  internalShown?: boolean;
  onToggleInternal?: () => void;
  t: TFunction;
};

function RecentConversationSkeleton() {
  return (
    <div className="space-y-1 px-1" aria-label="Loading recent conversations">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-2 rounded-lg px-2 py-2.5">
          <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${72 - index * 3}%` }} />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SidebarRecentConversations({
  conversations,
  projects,
  total,
  hasMore,
  isLoading,
  isLoadingMore,
  hasError,
  selectedSession,
  activeSessions,
  attentionSessionIds,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onLoadMore,
  onRetry,
  internalShown = false,
  onToggleInternal,
  t,
}: SidebarRecentConversationsProps) {
  /*
   * Строки — обычный элемент чата (SidebarSessionItem), как внутри папок и в
   * закреплённых «Промптах»: Егор 14.10.26 попросил «старый формат внешне» —
   * карточка с точкой статуса, названием, возрастом и меню «…», а не узкая
   * строка со стрелкой. Лента отдаёт урезанные поля, поэтому элемент чата
   * собирается здесь: open/rename/delete идут по sessionId+projectId, остальное
   * на строку не влияет.
   */
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.projectId, project])),
    [projects],
  );
  const sessionOf = (conversation: RecentConversationListItem): SessionWithProvider => ({
    id: conversation.sessionId,
    summary: conversation.sessionTitle,
    lastActivity: conversation.lastActivity ?? undefined,
    serverScope: conversation.serverScope ?? null,
    __provider: conversation.provider,
    __projectId: conversation.projectId ?? undefined,
  });
  const projectOf = (conversation: RecentConversationListItem): Project => (
    (conversation.projectId && projectById.get(conversation.projectId)) || {
      projectId: conversation.projectId ?? '',
      displayName: conversation.projectDisplayName,
      fullPath: '',
      serverScope: conversation.serverScope,
    }
  );

  if (isLoading && conversations.length === 0) {
    return <RecentConversationSkeleton />;
  }

  if (hasError && conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.loadFailed', 'Could not load recent conversations')}
        </p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
          {t('buttons.retry', { ns: 'common', defaultValue: 'Try again' })}
        </Button>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.emptyTitle', 'No conversations yet')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('recent.emptyDescription', 'Your most recently updated conversations will appear here.')}
        </p>
      </div>
    );
  }

  // Беседы разложены по дням: заголовок со счётчиком отвечает на вопрос
  // «где вчерашняя работа» сразу, без вглядывания в возраст каждой строки.
  //
  // Отдельно и первым — то, что Клод обдумывает прямо сейчас. Это главное, за
  // чем возвращаются в список: с телефона ответ ждут не глядя в экран, и найти
  // работающую беседу нужно одним движением, а не поиском зелёной точки по
  // всему списку.
  // Пока идёт обработка, lastActivity — это время последнего ЗАВЕРШЁННОГО
  // сообщения, а не текущего запуска: сортировка и возраст по нему для
  // работающих сессий врали (Егор 17.09.26: «давность запуска и очередность
  // не всегда» точны). startedAt — серверное время начала текущей обработки
  // из useSessionProtection (см. AppContent.refreshRunningSessions) — есть
  // только у активных сессий, поэтому это надёжный источник для этой группы.
  const running = conversations
    .filter((item) => activeSessions.has(item.sessionId))
    .sort((a, b) => {
      const aStarted = activeSessions.get(a.sessionId)?.startedAt ?? 0;
      const bStarted = activeSessions.get(b.sessionId)?.startedAt ?? 0;
      return bStarted - aStarted;
    });
  const idle = conversations.filter((item) => !activeSessions.has(item.sessionId));
  const groups = [
    ...(running.length > 0
      ? [{ key: 'running' as const, title: 'Сейчас работает', items: running }]
      : []),
    ...groupByRecency(idle, currentTime, (item) => item.lastActivity),
  ];

  const renderConversation = (conversation: RecentConversationListItem) => {
    const session = sessionOf(conversation);
    const project = projectOf(conversation);
    return (
      <SidebarSessionItem
        key={conversation.sessionId}
        project={project}
        session={session}
        selectedSession={selectedSession}
        isProcessing={activeSessions.has(conversation.sessionId)}
        needsAttention={attentionSessionIds.has(conversation.sessionId)}
        currentTime={currentTime}
        editingSession={editingSession}
        editingSessionName={editingSessionName}
        onEditingSessionNameChange={onEditingSessionNameChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        t={t}
      />
    );
  };

  return (
    <div className="px-1" data-testid="recent-conversations-list">
      <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('recent.title', 'Recent conversations')}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/70">{total}</span>
      </div>

      {groups.map((group) => (
        <div key={group.key} className="space-y-1 pb-1">
          <div className="flex items-center gap-1.5 px-2 pt-1">
            {group.key === 'running' ? (
              <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-green-500" aria-hidden />
            ) : (
              <span className="h-1 w-1 flex-shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
            )}
            <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
              {t(`recent.group.${group.key}`, { defaultValue: group.title })}
            </p>
            <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
              {group.items.length}
            </span>
          </div>
          {group.items.map(renderConversation)}
        </div>
      ))}

      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-8 w-full text-xs text-muted-foreground"
          onClick={onLoadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore
            ? t('recent.loadingMore', 'Loading more...')
            : t('recent.loadMore', 'Load older conversations')}
        </Button>
      )}

      {onToggleInternal && (
        <button
          type="button"
          onClick={onToggleInternal}
          className="mt-1 w-full rounded-md px-2 py-1 text-center text-[10px] text-muted-foreground/50 transition-colors hover:bg-accent/40 hover:text-muted-foreground"
        >
          {internalShown ? 'Скрыть служебные чаты' : 'Показать служебные чаты'}
        </button>
      )}
    </div>
  );
}
