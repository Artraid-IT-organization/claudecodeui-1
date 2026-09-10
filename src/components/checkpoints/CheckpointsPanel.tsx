import { useState } from 'react';
import { History, RotateCcw, Loader2, X, FileText } from 'lucide-react';

import { Button } from '../../shared/view/ui';
import { useCheckpoints, type Checkpoint } from '../../hooks/useCheckpoints';

/**
 * Список снимков состояния проекта с кнопкой отката.
 *
 * Открывается из шапки разговора. Показывает, что делал агент по шагам, и
 * позволяет вернуть файлы к любому моменту.
 *
 * Откат — необратимое на вид действие, поэтому здесь два предохранителя.
 * Первый: перед откатом человеку показывают точный список файлов, которые
 * изменятся, и он подтверждает. Второй, серверный: перед возвратом файлов
 * сервер снимает текущее состояние, так что «отменить отмену» всегда есть чем.
 */
type Props = {
  projectPath: string | null;
  sessionId: string | null;
  onClose: () => void;
};

function formatTime(iso: string): string {
  try {
    const date = new Date(iso);
    const today = new Date();
    const sameDay =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();
    const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return time;
    return `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
  } catch {
    return iso;
  }
}

export default function CheckpointsPanel({ projectPath, sessionId, onClose }: Props) {
  const { checkpoints, isLoading, error, preview, restore } = useCheckpoints(projectPath, sessionId);
  const [pending, setPending] = useState<{ checkpoint: Checkpoint; files: string[] } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const askRestore = async (checkpoint: Checkpoint) => {
    setIsBusy(true);
    setDone(null);
    try {
      const files = await preview(checkpoint.id);
      setPending({ checkpoint, files });
    } catch (err: any) {
      setDone(err?.message || 'Не удалось собрать список файлов');
    } finally {
      setIsBusy(false);
    }
  };

  const confirmRestore = async () => {
    if (!pending) return;
    setIsBusy(true);
    try {
      const result = await restore(pending.checkpoint.id);
      setDone(
        result.restored.length > 0
          ? `Вернул ${result.restored.length} ${pluralFiles(result.restored.length)}`
          : 'Возвращать было нечего — файлы уже в этом состоянии',
      );
      setPending(null);
    } catch (err: any) {
      setDone(err?.message || 'Не удалось вернуть файлы');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Снимки состояния</h2>
        </div>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Закрыть">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <p className="flex-shrink-0 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        Снимок делается перед каждым действием агента. Откат вернёт файлы к выбранному моменту;
        текущее состояние при этом сохранится отдельным снимком.
      </p>

      {done && (
        <div className="mx-4 mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground">
          {done}
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {isLoading && checkpoints.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground">Читаю снимки…</p>
        )}

        {!isLoading && checkpoints.length === 0 && !error && (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            Снимков пока нет. Они появятся, как только агент начнёт править файлы.
          </p>
        )}

        <ul className="space-y-1">
          {checkpoints.map((checkpoint) => (
            <li
              key={checkpoint.id}
              className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/40"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{checkpoint.label}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {formatTime(checkpoint.createdAt)}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="flex-shrink-0 gap-1 text-xs"
                disabled={isBusy}
                onClick={() => void askRestore(checkpoint)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Вернуть
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {pending && (
        <div className="flex-shrink-0 border-t border-border bg-muted/30 p-4">
          <p className="text-sm font-medium text-foreground">
            Вернуть к состоянию «{pending.checkpoint.label}»?
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatTime(pending.checkpoint.createdAt)}
          </p>

          {pending.files.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Файлы уже в этом состоянии — менять нечего.
            </p>
          ) : (
            <>
              <p className="mt-3 text-xs font-medium text-foreground">
                Изменится {pending.files.length} {pluralFiles(pending.files.length)}:
              </p>
              <ul className="mt-1 max-h-32 overflow-y-auto rounded border border-border bg-background p-2">
                {pending.files.slice(0, 40).map((file) => (
                  <li key={file} className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground">
                    <FileText className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{file}</span>
                  </li>
                ))}
                {pending.files.length > 40 && (
                  <li className="py-0.5 text-[11px] text-muted-foreground">
                    …и ещё {pending.files.length - 40}
                  </li>
                )}
              </ul>
            </>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPending(null)} disabled={isBusy}>
              Отмена
            </Button>
            <Button size="sm" onClick={() => void confirmRestore()} disabled={isBusy}>
              {isBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
              Вернуть файлы
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function pluralFiles(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'файл';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла';
  return 'файлов';
}
