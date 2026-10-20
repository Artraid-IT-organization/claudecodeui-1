import { useState } from 'react';
import { Download, FileJson, FileText, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import { authenticatedFetch } from '../../../../utils/api';
import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import type { ChatMessage } from '../../types/types';
import { downloadMarkdown, downloadHTML, downloadPDF, EXPORT_FORMATS } from '../../utils/chatExport';

type ChatExportMenuProps = {
  /** Сколько сообщений в ленте прямо сейчас — только чтобы не рисовать кнопку у пустого чата. */
  loadedCount: number;
  /** Сколько сообщений в переписке всего, по данным сервера. */
  totalCount: number;
  /** Идентификатор чата — по нему сервер отдаёт полную переписку потоком. */
  sessionId?: string;
  /** Дотянуть всю переписку с сервера (запасной путь). */
  onLoadAll: () => Promise<void> | void;
  /** Свежий список сообщений — читается ПОСЛЕ дозагрузки, поэтому функцией. */
  getMessages: () => ChatMessage[];
  sessionTitle?: string;
};

/**
 * Ждёт, пока дозагрузка уляжется.
 *
 * `onLoadAll` возвращает управление раньше, чем подтянутое доедет до ленты:
 * сообщения приходят через хранилище, и обновление происходит уже в следующих
 * отрисовках. Поэтому ждём, пока счётчик перестанет расти — три спокойные
 * проверки подряд, но не дольше пятнадцати секунд.
 */
async function waitUntilSettled(getCount: () => number): Promise<void> {
  let previous = -1;
  let calm = 0;
  for (let step = 0; step < 150; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = getCount();
    if (current === previous) {
      calm += 1;
      if (calm >= 3) return;
    } else {
      calm = 0;
      previous = current;
    }
  }
}

/**
 * Вся переписка с сервера одним потоком.
 *
 * Путь «дозагрузить ленту и сохранить видимое» обрезал длинные чаты: сервер
 * держит полную историю лишь в пределах ~12 МБ с конца стенограммы, поэтому
 * файл начинался с середины и без первых сообщений человека
 * (Егор 17.10.26: «чат должен быть весь всегда»). Отдельная точка
 * `/messages/export` отдаёт каждое сообщение по мере чтения источника —
 * от первого до последнего, независимо от объёма.
 */
async function fetchWholeTranscript(sessionId: string): Promise<ChatMessage[]> {
  const response = await authenticatedFetch(
    `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages/export`,
  );
  if (!response.ok || !response.body) {
    throw new Error(`export stream failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const normalized: NormalizedMessage[] = [];
  let carry = '';
  let streamError: string | null = null;

  const takeLine = (line: string) => {
    if (!line.trim()) return;
    const parsed = JSON.parse(line) as NormalizedMessage & { exportError?: string };
    if (parsed.exportError) {
      streamError = parsed.exportError;
      return;
    }
    normalized.push(parsed);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    let cut = carry.indexOf('\n');
    while (cut !== -1) {
      takeLine(carry.slice(0, cut));
      carry = carry.slice(cut + 1);
      cut = carry.indexOf('\n');
    }
  }
  if (carry.trim()) takeLine(carry);
  if (streamError) throw new Error(streamError);

  return normalizedToChatMessages(normalized);
}

/** Кусок названия для имени файла: без служебных символов и не длиннее 60 знаков. */
const toFilenamePart = (value: string): string =>
  value
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();

/** Штамп «гггг-мм-дд-чч-мм» — по нему видно и день, и минуту выгрузки. */
const formatExportStamp = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}-${pad(date.getMinutes())}`
  );
};

export default function ChatExportMenu({
  loadedCount,
  totalCount,
  sessionId,
  onLoadAll,
  getMessages,
  sessionTitle,
}: ChatExportMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);

  if (loadedCount === 0) {
    return null;
  }

  const handleExport = async (format: 'markdown' | 'html' | 'pdf') => {
    if (isPreparing) return;
    setIsPreparing(true);
    try {
      // Основной путь — полный поток с сервера: переписка целиком, от первого
      // сообщения, вне зависимости от длины чата. Запасной путь (поток
      // недоступен) — дотянуть ленту как раньше.
      let messages: ChatMessage[];
      if (sessionId) {
        try {
          messages = await fetchWholeTranscript(sessionId);
        } catch {
          await onLoadAll();
          await waitUntilSettled(() => getMessages().length);
          messages = getMessages();
        }
      } else {
        await onLoadAll();
        await waitUntilSettled(() => getMessages().length);
        messages = getMessages();
      }
      const firstUserText = messages.find((msg) => msg.type === 'user')?.content;
      const fallbackName = typeof firstUserText === 'string' ? firstUserText : '';
      const namePart = toFilenamePart(sessionTitle || fallbackName || 'chat') || 'chat';
      const filename = `${namePart}-${formatExportStamp(new Date())}`;

      switch (format) {
        case 'markdown':
          downloadMarkdown(messages, `${filename}.md`, sessionTitle);
          break;
        case 'html':
          downloadHTML(messages, `${filename}.html`, sessionTitle);
          break;
        case 'pdf':
          downloadPDF(messages, filename, sessionTitle);
          break;
      }
      setIsOpen(false);
    } finally {
      setIsPreparing(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={t('export.button', { defaultValue: 'Сохранить переписку' })}
        title={t('export.button', { defaultValue: 'Сохранить переписку' })}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/50 text-muted-foreground transition-all hover:bg-accent hover:text-foreground"
      >
        {isPreparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-border/50 bg-card shadow-lg">
          <div className="p-2">
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              {t('export.title', { defaultValue: 'Сохранить как:' })}
            </div>
            {isPreparing ? (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>
                  {t('export.preparing', {
                    defaultValue: 'Собираю всю переписку…',
                  })}
                </span>
              </div>
            ) : (
              EXPORT_FORMATS.map((fmt) => (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => void handleExport(fmt.id as 'markdown' | 'html' | 'pdf')}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                >
                  {fmt.id === 'markdown' ? (
                    <FileText className="h-4 w-4" />
                  ) : (
                    <FileJson className="h-4 w-4" />
                  )}
                  <span>{fmt.label}</span>
                </button>
              ))
            )}
            {totalCount > loadedCount && !isPreparing && (
              <p className="px-3 pb-1 pt-2 text-[11px] leading-snug text-muted-foreground/80">
                {t('export.willLoadAll', {
                  count: totalCount,
                  defaultValue: `В файл попадёт вся переписка — все ${totalCount} сообщений, а не только загруженные.`,
                })}
              </p>
            )}
          </div>
        </div>
      )}

      {isOpen && <div className="fixed inset-0" onClick={() => setIsOpen(false)} />}
    </div>
  );
}
