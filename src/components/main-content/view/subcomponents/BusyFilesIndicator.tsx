import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';

import { Tooltip } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';

/**
 * Показывает, что в этом проекте прямо сейчас работает кто-то ещё.
 *
 * Раньше два чата молча затирали работу друг друга, и человек узнавал об этом
 * через час, когда что-то переставало работать без причины. Значок делает
 * соседа видимым: сколько файлов он держит и какие именно.
 *
 * Появляется, только когда есть что показать. В одиночной работе — а это
 * большинство времени — на экране не меняется ничего.
 */
type Reservation = {
  id: number;
  filePath: string;
  sessionId: string;
  sessionTitle: string | null;
};

type Props = {
  projectPath: string | null;
  /** Свой разговор из списка исключаем: интересны соседи, а не мы сами. */
  currentSessionId: string | null;
};

const POLL_INTERVAL_MS = 5000;

export default function BusyFilesIndicator({ projectPath, currentSessionId }: Props) {
  const [others, setOthers] = useState<Reservation[]>([]);

  useEffect(() => {
    if (!projectPath) {
      setOthers([]);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const params = new URLSearchParams({ projectPath });
        const response = await authenticatedFetch(`/api/coordination/active?${params.toString()}`);
        if (!response.ok) return;
        const json = await response.json();
        if (cancelled) return;
        const list: Reservation[] = Array.isArray(json?.reservations) ? json.reservations : [];
        setOthers(list.filter((item) => item.sessionId !== currentSessionId));
      } catch {
        // Сеть моргнула — просто ждём следующего опроса.
      }
    };

    void load();
    // Опрос, а не подписка: событие «сосед взял файл» живёт секунды, и городить
    // ради него отдельный канал в вебсокете невыгодно.
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectPath, currentSessionId]);

  if (others.length === 0) return null;

  const names = [...new Set(others.map((item) => item.sessionTitle || 'другой чат'))];
  const fileList = others
    .slice(0, 6)
    .map((item) => item.filePath.split('/').slice(-2).join('/'))
    .join('\n');
  const more = others.length > 6 ? `\n…и ещё ${others.length - 6}` : '';

  return (
    <Tooltip
      content={`${names.join(', ')} сейчас правит:\n${fileList}${more}`}
      position="bottom"
    >
      <span
        aria-label={`Рядом работает ${names.join(', ')}, занято файлов: ${others.length}`}
        className="flex flex-shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
      >
        <Users className="h-3.5 w-3.5" />
        <span className="tabular-nums">{others.length}</span>
      </span>
    </Tooltip>
  );
}
