import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDownIcon, ChevronUpIcon, PencilIcon, SendHorizontalIcon, XIcon } from 'lucide-react';

import { safeLocalStorage } from '../../utils/chatStorage';

export interface QueuedMessageView {
  id: string;
  content: string;
  attachmentCount: number;
}

interface MessageQueueDockProps {
  items: QueuedMessageView[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  /** Нет — провайдер не умеет вставлять сообщение в идущий ход, кнопки нет. */
  onSendNow?: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onClear: () => void;
}

const DOCK_COLLAPSED_KEY = 'queue_dock_collapsed';

/**
 * Очередь сообщений над полем ввода.
 *
 * Почему именно так:
 * — первое сообщение развёрнуто и подписано «следующим», остальные идут
 *   строками: очередь из пяти штук не должна занимать пол-экрана телефона;
 * — порядок меняется стрелками, а не перетаскиванием: док живёт внутри
 *   прокручиваемой области, и на телефоне драг там промахивается мимо цели —
 *   в разборе чужих реализаций (Codex CLI, плагин для JetBrains) это самая
 *   частая жалоба, и обе они desktop-only;
 * — любое сообщение раскрывается касанием по тексту и видно целиком;
 * — весь док складывается в одну строку, и это запоминается между заходами.
 */
export default function MessageQueueDock({
  items,
  onEdit,
  onDelete,
  onSendNow,
  onMove,
  onClear,
}: MessageQueueDockProps) {
  const { t } = useTranslation('chat');
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [isDockCollapsed, setIsDockCollapsed] = useState(
    () => safeLocalStorage.getItem(DOCK_COLLAPSED_KEY) === '1',
  );
  // «Очистить» стирает до пяти подготовленных сообщений, а стоит вплотную к
  // заголовку — один промах пальцем не должен уносить всю работу. Поэтому
  // первое касание только переспрашивает и само гаснет через три секунды.
  const [isClearArmed, setIsClearArmed] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
    }
  }, []);

  const handleClear = useCallback(() => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    if (isClearArmed) {
      setIsClearArmed(false);
      onClear();
      return;
    }
    setIsClearArmed(true);
    clearTimerRef.current = setTimeout(() => setIsClearArmed(false), 3000);
  }, [isClearArmed, onClear]);

  const toggleDock = useCallback(() => {
    setIsDockCollapsed((prev) => {
      safeLocalStorage.setItem(DOCK_COLLAPSED_KEY, prev ? '0' : '1');
      return !prev;
    });
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  if (items.length === 0) {
    return null;
  }

  const many = items.length > 1;

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] overflow-hidden rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04]">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
        <button
          type="button"
          onClick={toggleDock}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={!isDockCollapsed}
        >
          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-primary/70">
            {t('input.queue.label', { defaultValue: 'Queued' })}
            {many ? ` · ${items.length}` : ''}
          </span>
          <span className="truncate text-[11px] text-muted-foreground/60">
            {many
              ? t('input.queue.willSendMany', { defaultValue: 'Will send one by one, in this order' })
              : t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })}
          </span>
        </button>
        {many && (
          <button
            type="button"
            onClick={handleClear}
            className={`shrink-0 rounded-md px-2 py-1.5 text-[11px] transition-colors ${
              isClearArmed
                ? 'bg-destructive/15 font-medium text-destructive'
                : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
            }`}
          >
            {isClearArmed
              ? t('input.queue.clearConfirm', { defaultValue: 'Tap again to clear' })
              : t('input.queue.clear', { defaultValue: 'Clear all' })}
          </button>
        )}
        <button
          type="button"
          onClick={toggleDock}
          aria-label={
            isDockCollapsed
              ? t('input.queue.expandDock', { defaultValue: 'Show the queue' })
              : t('input.queue.collapseDock', { defaultValue: 'Hide the queue' })
          }
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {isDockCollapsed ? <ChevronUpIcon className="h-4 w-4" /> : <ChevronDownIcon className="h-4 w-4" />}
        </button>
      </div>

      {!isDockCollapsed && (
        <ul className="max-h-[42vh] overflow-y-auto overscroll-contain">
          {items.map((item, index) => {
            const isExpanded = expandedIds.has(item.id);
            const isFirst = index === 0;
            const isLast = index === items.length - 1;

            return (
              <li key={item.id} className="border-t border-primary/10">
                <div className="flex items-start gap-2 px-3 py-2">
                  {many && (
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                        isFirst ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                      }`}
                      aria-hidden
                    >
                      {index + 1}
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={() => toggleExpanded(item.id)}
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={isExpanded}
                    aria-label={t('input.queue.toggleText', { defaultValue: 'Show the full message' })}
                  >
                    {isFirst && many && (
                      <span className="block text-[10px] font-medium uppercase tracking-wide text-primary/60">
                        {t('input.queue.next', { defaultValue: 'Next' })}
                      </span>
                    )}
                    <p
                      className={`break-words text-sm text-foreground/90 ${
                        isExpanded ? 'whitespace-pre-wrap' : isFirst ? 'line-clamp-2' : 'line-clamp-1'
                      }`}
                    >
                      {item.content}
                    </p>
                    {item.attachmentCount > 0 && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t('input.queue.attachments', {
                          defaultValue: '{{count}} files attached',
                          count: item.attachmentCount,
                        })}
                      </span>
                    )}
                  </button>

                  <div className="flex shrink-0 items-center">
                    {many && (
                      <>
                        <button
                          type="button"
                          onClick={() => onMove(item.id, -1)}
                          disabled={isFirst}
                          aria-label={t('input.queue.moveUp', { defaultValue: 'Move up' })}
                          title={t('input.queue.moveUp', { defaultValue: 'Move up' })}
                          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
                        >
                          <ChevronUpIcon className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onMove(item.id, 1)}
                          disabled={isLast}
                          aria-label={t('input.queue.moveDown', { defaultValue: 'Move down' })}
                          title={t('input.queue.moveDown', { defaultValue: 'Move down' })}
                          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
                        >
                          <ChevronDownIcon className="h-4 w-4" />
                        </button>
                      </>
                    )}
                    {/* «Сейчас» — не ждать конца ответа (Егор 22.09.26, как
                        «Send now» у Cursor): Claude прочтёт сообщение на
                        ближайшем шаге и не бросит сделанное. Подпись словом,
                        а не одной иконкой — рядом карандаш и крестик, и
                        безымянная стрелка читалась бы как «отправить в конец». */}
                    {onSendNow && (
                    <button
                      type="button"
                      onClick={() => onSendNow(item.id)}
                      aria-label={t('input.queue.sendNowHint', { defaultValue: 'Send now — Claude reads it at the next step' })}
                      title={t('input.queue.sendNowHint', { defaultValue: 'Send now — Claude reads it at the next step' })}
                      className="mr-0.5 flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                    >
                      <SendHorizontalIcon className="h-3.5 w-3.5" />
                      {/* При нескольких сообщениях на телефоне рядом ещё две
                          стрелки, и подпись сжимала текст сообщения до одного
                          слова (снимок 390px, 22.09.26) — там только иконка
                          на синем фоне, подсказка остаётся в title. */}
                      <span className={many ? 'hidden sm:inline' : undefined}>
                        {t('input.queue.sendNow', { defaultValue: 'Now' })}
                      </span>
                    </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onEdit(item.id)}
                      aria-label={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
                      title={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
                      className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <PencilIcon className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(item.id)}
                      aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
                      title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
                      className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <XIcon className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
