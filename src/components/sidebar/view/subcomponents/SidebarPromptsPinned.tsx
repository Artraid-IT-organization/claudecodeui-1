import { ChevronDown, Star } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import type { Project } from '../../../../types/app';


/*
 * Проект «Промпты» (/home/claude/prompts) закреплён над общей лентой чатов.
 *
 * Егор 14.10.26: список слева снова плоский — все чаты по свежести, папок
 * нет — а «Промпты» должны оставаться в одном касании сверху. Секция
 * свёрнута в одну строку: обычная карточка папки со звёздой, счётчиком и
 * меню съедала бы у ленты рост вдвое больший, чем весь этот блок.
 *
 * Шапка живёт ВНЕ области прокрутки и не уезжает, а чаты проекта
 * раскрываются первым элементом внутри общей ленты — отдельного
 * мини-скролла внутри секции нет. Состояние раскрытия помнит устройство
 * (readPromptsPinnedExpanded в utils/utils.ts).
 */

type SidebarPromptsPinnedProps = {
  project: Project;
  expanded: boolean;
  onToggle: () => void;
};

export default function SidebarPromptsPinned({
  project,
  expanded,
  onToggle,
}: SidebarPromptsPinnedProps) {
  const sessionCount = Number(project.sessionMeta?.total ?? 0);

  return (
    <div
      className={cn(
        'flex-shrink-0 border-b transition-colors',
        expanded ? 'border-amber-500/30 bg-amber-500/[0.07]' : 'border-border/60',
      )}
      data-testid="prompts-pinned"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/50"
      >
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-amber-500/15">
          <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground">
          {project.displayName}
        </span>
        {sessionCount > 0 && (
          <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
            {sessionCount}
          </span>
        )}
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50 transition-transform',
            !expanded && '-rotate-90',
          )}
        />
      </button>
    </div>
  );
}
