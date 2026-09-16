import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { Terminal } from '@xterm/xterm';

import { copyTextToClipboard } from '../../../../utils/clipboard';
import { getTerminalPlainText } from '../../utils/terminalClipboard';

/*
 * Окно с текстом терминала для телефона.
 *
 * «Ввод» — поле, куда вставляют или набирают текст системными средствами
 * телефона (долгое нажатие → Вставить, лупа, перемещение курсора) и отправляют
 * в терминал одной кнопкой. Нужно, когда браузер не даёт прочитать буфер, и
 * когда длинную команду удобнее поправить до отправки.
 *
 * «Текст» — весь вывод терминала обычным текстом. Выделение в самом терминале
 * рисуем мы, и оно ограничено одним экраном; здесь работает родное выделение
 * телефона на любую длину, с лупой и системным меню.
 */

export type TerminalTextSheetMode = 'input' | 'view';

type TerminalTextSheetProps = {
  mode: TerminalTextSheetMode;
  terminal: Terminal | null;
  onClose: () => void;
};

const SHEET_BTN =
  'rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm font-medium text-gray-100 active:bg-gray-600 disabled:opacity-40';
const SHEET_BTN_PRIMARY =
  'rounded-lg border border-blue-500 bg-blue-600 px-3 py-2 text-sm font-medium text-white active:bg-blue-700 disabled:opacity-40';

export default function TerminalTextSheet({ mode, terminal, onClose }: TerminalTextSheetProps) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<HTMLPreElement>(null);
  const [viewText] = useState(() => (mode === 'view' && terminal ? getTerminalPlainText(terminal) : ''));

  useEffect(() => {
    if (mode === 'input') {
      textareaRef.current?.focus();
    }
  }, [mode]);

  // Открываем на последних строках — там то, что только что вывелось.
  useLayoutEffect(() => {
    if (mode === 'view' && viewRef.current) {
      viewRef.current.scrollTop = viewRef.current.scrollHeight;
    }
  }, [mode]);

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 1500);
  };

  const sendDraft = () => {
    if (!terminal || draft.length === 0) {
      return;
    }
    terminal.paste(draft);
    onClose();
  };

  const copyAll = async () => {
    const copied = await copyTextToClipboard(viewText);
    flash(
      copied
        ? t('terminalShortcuts.copied', { defaultValue: 'Скопировано' })
        : t('terminalShortcuts.copyFailed', { defaultValue: 'Не удалось скопировать' }),
    );
  };

  const copySelected = async () => {
    const selected = window.getSelection()?.toString() ?? '';
    if (!selected) {
      flash(t('terminalShortcuts.selectFirst', { defaultValue: 'Сначала выделите текст' }));
      return;
    }
    const copied = await copyTextToClipboard(selected);
    flash(
      copied
        ? t('terminalShortcuts.copied', { defaultValue: 'Скопировано' })
        : t('terminalShortcuts.copyFailed', { defaultValue: 'Не удалось скопировать' }),
    );
  };

  const title =
    mode === 'input'
      ? t('terminalShortcuts.inputTitle', { defaultValue: 'Вставить или набрать текст' })
      : t('terminalShortcuts.viewTitle', { defaultValue: 'Текст терминала' });

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-gray-950/95 md:hidden"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-2">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-100">{title}</div>
        {notice && <div className="shrink-0 text-xs text-green-400">{notice}</div>}
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md p-2 text-gray-300 active:bg-gray-800"
          aria-label={t('terminalShortcuts.close', { defaultValue: 'Закрыть' })}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {mode === 'input' ? (
        <>
          <div className="px-3 pt-2 text-xs text-gray-400">
            {t('terminalShortcuts.inputHint', {
              defaultValue: 'Нажмите и удерживайте поле → «Вставить». Текст уйдёт в терминал без Enter.',
            })}
          </div>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            // 16px и больше — иначе iPhone увеличивает страницу при фокусе.
            className="m-3 min-h-0 flex-1 resize-none rounded-lg border border-gray-700 bg-gray-900 p-3 font-mono text-base text-gray-100 outline-none focus:border-blue-500"
          />
          <div className="flex justify-end gap-2 px-3 pb-3">
            <button type="button" onClick={onClose} className={SHEET_BTN}>
              {t('terminalShortcuts.cancel', { defaultValue: 'Отмена' })}
            </button>
            <button
              type="button"
              onClick={sendDraft}
              disabled={draft.length === 0}
              className={SHEET_BTN_PRIMARY}
            >
              {t('terminalShortcuts.sendToTerminal', { defaultValue: 'В терминал' })}
            </button>
          </div>
        </>
      ) : (
        <>
          <pre
            ref={viewRef}
            className="m-0 min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[13px] leading-snug text-gray-100"
            style={{ WebkitUserSelect: 'text', WebkitTouchCallout: 'default' } as React.CSSProperties}
          >
            {viewText}
          </pre>
          <div className="flex justify-end gap-2 border-t border-gray-800 px-3 py-2">
            <button type="button" onClick={() => void copySelected()} className={SHEET_BTN}>
              {t('terminalShortcuts.copySelected', { defaultValue: 'Копировать выделенное' })}
            </button>
            <button type="button" onClick={() => void copyAll()} className={SHEET_BTN_PRIMARY}>
              {t('terminalShortcuts.copyAll', { defaultValue: 'Копировать всё' })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
