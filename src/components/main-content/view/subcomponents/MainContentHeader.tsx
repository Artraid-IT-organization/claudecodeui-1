import type { MainContentHeaderProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';
import MainContentTitle from './MainContentTitle';
import ConnectionStatus from './ConnectionStatus';
import ChatGroupSelector from './ChatGroupSelector';

export default function MainContentHeader({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
  terminalTitle = null,
  terminalProjectName = null,
  onSessionArchived,
  onSessionRestored,
}: MainContentHeaderProps) {
  return (
    <header className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background/95 px-3 py-2 backdrop-blur-sm sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
        <MainContentTitle
          activeTab={activeTab}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          shouldShowTasksTab={shouldShowTasksTab}
          terminalTitle={terminalTitle}
          terminalProjectName={terminalProjectName}
        />
        {/*
          На этом месте раньше был переключатель пресетов. Егор попросил вместо
          него группу чата и архив: это нужно каждый день, а пресеты — редко,
          и включаются теперь в настройках.
        */}
        {activeTab === 'chat' && !terminalTitle && (
          <ChatGroupSelector
            sessionId={selectedSession?.id ?? null}
            sessionGroupId={selectedSession ? (selectedSession.groupId ?? null) : undefined}
            onArchived={onSessionArchived}
            onRestored={onSessionRestored}
          />
        )}
        <ConnectionStatus />
      </div>
    </header>
  );
}
