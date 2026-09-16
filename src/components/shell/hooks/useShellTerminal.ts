import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/xterm';

import i18n from '../../../i18n/config.js';
import type { Project } from '../../../types/app';
import { copyTextToClipboard } from '../../../utils/clipboard';
import {
  TERMINAL_INIT_DELAY_MS,
  TERMINAL_OPTIONS,
  TERMINAL_RESIZE_DELAY_MS,
} from '../constants/constants';
import {
  installMobileTerminalSelection,
  type MobileTerminalSelectionManager,
} from '../utils/mobileTerminalSelection';
import { sendSocketMessage } from '../utils/socket';
import { ensureXtermFocusStyles } from '../utils/terminalStyles';

// CLIs running inside the pty (e.g. `claude auth login`'s "press c to copy"
// device-flow prompt) write to the clipboard via an OSC 52 escape sequence,
// not a browser event — xterm.js ignores OSC 52 unless a clipboard addon is
// loaded. Routes writes through the same fallback-aware helper the terminal's
// own selection-copy shortcut uses, since `navigator.clipboard` is often
// unavailable on self-hosted, non-HTTPS deployments.
// `ClipboardSelectionType.SYSTEM` is `'c'` (vs. `'p'` for the X11 primary
// selection) — compared as a literal since the addon ships it as a const
// enum, which isolatedModules builds (esbuild/Vite) can't import as a value.
const oscClipboardProvider: IClipboardProvider = {
  readText: async (selection) => {
    if (selection !== 'c') {
      return '';
    }
    try {
      return (await navigator.clipboard?.readText?.()) || '';
    } catch {
      return '';
    }
  },
  writeText: async (selection, text) => {
    if (selection !== 'c') {
      return;
    }
    await copyTextToClipboard(text);
  },
};

// The addon's published typings declare a single `(provider?)` constructor
// param, but the shipped runtime actually takes `(base64?, provider?)` — see
// node_modules/@xterm/addon-clipboard/lib/addon-clipboard.js. Cast to call it
// the way it's really implemented.
const ClipboardAddonCtor = ClipboardAddon as unknown as new (
  base64?: unknown,
  provider?: IClipboardProvider,
) => ClipboardAddon;

type UseShellTerminalOptions = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  serializeAddonRef: MutableRefObject<SerializeAddon | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  selectedProject: Project | null | undefined;
  minimal: boolean;
  isRestarting: boolean;
  closeSocket: () => void;
};

type UseShellTerminalResult = {
  isInitialized: boolean;
  clearTerminalScreen: () => void;
  disposeTerminal: () => void;
};

/**
 * Видно ли окно терминала на экране.
 *
 * Пока командная строка была одна, вопрос не стоял: она либо на экране, либо
 * размонтирована. Теперь окон несколько, и невыбранные просто спрятаны —
 * браузер сообщает про них нулевой размер. Подгонка под нулевой размер честно
 * пересчитывает сетку в один столбец, переносит по нему всю историю и сообщает
 * этот размер запущенной программе: строки схлопываются, а то, что рисует
 * рамки (тот же Клод в терминале), рассыпается. Проверка возвращает подгонку
 * только видимым окнам.
 */
function isVisibleBox(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function useShellTerminal({
  terminalContainerRef,
  terminalRef,
  fitAddonRef,
  serializeAddonRef,
  wsRef,
  selectedProject,
  minimal,
  isRestarting,
  closeSocket,
}: UseShellTerminalOptions): UseShellTerminalResult {
  const [isInitialized, setIsInitialized] = useState(false);
  const resizeTimeoutRef = useRef<number | null>(null);
  const mobileSelectionRef = useRef<MobileTerminalSelectionManager | null>(null);
  const selectedProjectKey = selectedProject?.fullPath || selectedProject?.path || '';
  const hasSelectedProject = Boolean(selectedProject);

  useEffect(() => {
    ensureXtermFocusStyles();
  }, []);

  const clearTerminalScreen = useCallback(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.clear();
    terminalRef.current.write('\x1b[2J\x1b[H');
  }, [terminalRef]);

  const disposeTerminal = useCallback(() => {
    if (mobileSelectionRef.current) {
      mobileSelectionRef.current.dispose();
      mobileSelectionRef.current = null;
    }

    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    fitAddonRef.current = null;
    setIsInitialized(false);
  }, [fitAddonRef, terminalRef]);

  useEffect(() => {
    const terminalContainer = terminalContainerRef.current;
    if (!terminalContainer || !hasSelectedProject || isRestarting || terminalRef.current) {
      return;
    }

    const nextTerminal = new Terminal(TERMINAL_OPTIONS);
    terminalRef.current = nextTerminal;

    const nextFitAddon = new FitAddon();
    fitAddonRef.current = nextFitAddon;
    nextTerminal.loadAddon(nextFitAddon);

    /*
     * Сериализатор экрана.
     *
     * Позволяет снять весь видимый экран (курсор, цвета, содержимое) одной
     * строкой ANSI-кодов. Пригождается один раз — перед закрытием вкладки:
     * снимок уходит серверу, и когда та же вкладка снова откроется, сервер
     * пришлёт его назад, экран мгновенно окажется в том же состоянии.
     */
    const nextSerializeAddon = new SerializeAddon();
    serializeAddonRef.current = nextSerializeAddon;
    nextTerminal.loadAddon(nextSerializeAddon);

    nextTerminal.loadAddon(new ClipboardAddonCtor(undefined, oscClipboardProvider));

    // Avoid wrapped partial links in compact login flows.
    if (!minimal) {
      nextTerminal.loadAddon(new WebLinksAddon());
    }

    try {
      nextTerminal.loadAddon(new WebglAddon());
    } catch {
      console.warn('[Shell] WebGL renderer unavailable, using Canvas fallback');
    }

    nextTerminal.open(terminalContainer);
    mobileSelectionRef.current = installMobileTerminalSelection(
      nextTerminal,
      terminalContainer,
      {
        labels: {
          copy: i18n.t('settings:terminalShortcuts.copy', { defaultValue: 'Копировать' }),
          paste: i18n.t('settings:terminalShortcuts.paste', { defaultValue: 'Вставить' }),
          selectAll: i18n.t('settings:terminalShortcuts.selectAll', { defaultValue: 'Выделить всё' }),
          copied: i18n.t('settings:terminalShortcuts.copied', { defaultValue: 'Скопировано' }),
          copyFailed: i18n.t('settings:terminalShortcuts.copyFailed', {
            defaultValue: 'Не удалось скопировать',
          }),
        },
        onFontSizeChange: (fontSize) => {
          nextTerminal.options.fontSize = fontSize;

          const currentFitAddon = fitAddonRef.current;
          if (currentFitAddon) {
            currentFitAddon.fit();
            sendSocketMessage(wsRef.current, {
              type: 'resize',
              cols: nextTerminal.cols,
              rows: nextTerminal.rows,
            });
          } else {
            nextTerminal.refresh(0, nextTerminal.rows - 1);
          }
        },
      },
    );

    const copyTerminalSelection = async () => {
      const selection = nextTerminal.getSelection();
      if (!selection) {
        return false;
      }

      return copyTextToClipboard(selection);
    };

    const handleTerminalCopy = (event: ClipboardEvent) => {
      if (!nextTerminal.hasSelection()) {
        return;
      }

      const selection = nextTerminal.getSelection();
      if (!selection) {
        return;
      }

      event.preventDefault();

      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', selection);
        return;
      }

      void copyTextToClipboard(selection);
    };

    terminalContainer.addEventListener('copy', handleTerminalCopy);

    /*
     * Копирование и вставка с клавиатуры — как в обычном терминале.
     *
     * Ctrl/Cmd+C с выделением копирует, без выделения Ctrl+C прерывает команду.
     * Ctrl+Shift+C копирует всегда и никогда не прерывает — привычка из
     * терминалов Linux и Windows.
     *
     * Ctrl/Cmd+V и Ctrl+Shift+V: терминалу клавишу не отдаём (иначе он пошлёт
     * программе ^V), но и браузеру не мешаем — он сам вставит текст в скрытое
     * поле терминала, а терминал обработает это как настоящую вставку.
     * Раньше здесь читался буфер вручную и текст уходил как набранный: в
     * Firefox вставка не работала вовсе, а многострочный текст выполнялся
     * построчно прямо при вставке.
     */
    nextTerminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey) || event.altKey) {
        return true;
      }

      const key = event.key?.toLowerCase();

      if (key === 'c' && (nextTerminal.hasSelection() || (event.ctrlKey && event.shiftKey))) {
        event.preventDefault();
        event.stopPropagation();
        void copyTerminalSelection();
        return false;
      }

      if (key === 'v') {
        return false;
      }

      return true;
    });

    window.setTimeout(() => {
      const currentFitAddon = fitAddonRef.current;
      const currentTerminal = terminalRef.current;
      if (!currentFitAddon || !currentTerminal) {
        return;
      }

      if (!isVisibleBox(terminalContainerRef.current)) {
        return;
      }

      currentFitAddon.fit();
      sendSocketMessage(wsRef.current, {
        type: 'resize',
        cols: currentTerminal.cols,
        rows: currentTerminal.rows,
      });
    }, TERMINAL_INIT_DELAY_MS);

    setIsInitialized(true);

    const dataSubscription = nextTerminal.onData((data) => {
      sendSocketMessage(wsRef.current, {
        type: 'input',
        data,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = window.setTimeout(() => {
        const currentFitAddon = fitAddonRef.current;
        const currentTerminal = terminalRef.current;
        if (!currentFitAddon || !currentTerminal) {
          return;
        }

        if (!isVisibleBox(terminalContainerRef.current)) {
          return;
        }

        currentFitAddon.fit();
        sendSocketMessage(wsRef.current, {
          type: 'resize',
          cols: currentTerminal.cols,
          rows: currentTerminal.rows,
        });
      }, TERMINAL_RESIZE_DELAY_MS);
    });

    resizeObserver.observe(terminalContainer);

    return () => {
      terminalContainer.removeEventListener('copy', handleTerminalCopy);
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      dataSubscription.dispose();
      closeSocket();
      disposeTerminal();
    };
    // Демонтаж окна — попытка снять снапшот в самом конце. Если сервер
    // ещё жив и WS открыт, отправим сериализованный экран: возврат в это же
    // окно позже восстановит его в точности. Ошибки здесь глушим — снапшот
    // это подсказка, не обязательство.
    const captureSnapshotOnUnmount = () => {
      const addon = serializeAddonRef.current;
      const socket = wsRef.current;
      if (!addon || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        const dump = addon.serialize();
        if (dump && dump.length > 0) {
          socket.send(JSON.stringify({ type: 'snapshot', data: dump }));
        }
      } catch {
        /* сериализатор не готов — не страшно */
      }
    };

    // Захватываем в локальную const: тайпчекер теряет narrowing на
    // `terminalContainer` из-за новых ветвей контроля потока, добавленных
    // выше (снапшот перед демонтажом).
    const currentContainer = terminalContainer;

    return () => {
      captureSnapshotOnUnmount();
      currentContainer?.removeEventListener('copy', handleTerminalCopy);
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      dataSubscription.dispose();
      closeSocket();
      disposeTerminal();
    };
  }, [
    closeSocket,
    disposeTerminal,
    fitAddonRef,
    isRestarting,
    hasSelectedProject,
    minimal,
    selectedProjectKey,
    terminalContainerRef,
    terminalRef,
    wsRef,
  ]);

  return {
    isInitialized,
    clearTerminalScreen,
    disposeTerminal,
  };
}
