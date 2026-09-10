import { History } from 'lucide-react';

import { Button, Tooltip } from '../../../../shared/view/ui';
import type { MainContentHeaderProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';
import MainContentTitle from './MainContentTitle';
import ConnectionStatus from './ConnectionStatus';
import BusyFilesIndicator from './BusyFilesIndicator';
import PresetSelector from './PresetSelector';

export default function MainContentHeader({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
  terminalTitle = null,
  onOpenCheckpoints,
  isSessionProcessing = false,
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
        />
        {activeTab === 'chat' && !terminalTitle && <PresetSelector />}
        {/*
          Кнопка отката. Живёт рядом с заголовком, потому что относится ко
          всему проекту, а не к отдельному сообщению: снимки копятся по ходу
          работы агента, и вернуться человек хочет «к моменту», а не «к строке».
        */}
        {onOpenCheckpoints && !terminalTitle && (
          <Tooltip content="Снимки состояния — вернуть файлы назад" position="bottom">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onOpenCheckpoints}
              aria-label="Снимки состояния"
            >
              <History className="h-4 w-4" />
            </Button>
          </Tooltip>
        )}
        <BusyFilesIndicator
          projectPath={selectedProject?.fullPath || selectedProject?.path || null}
          currentSessionId={selectedSession?.id ?? null}
        />
        <ConnectionStatus isProcessing={isSessionProcessing} />
      </div>
    </header>
  );
}
