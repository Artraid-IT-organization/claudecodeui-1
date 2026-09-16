import type { Terminal } from '@xterm/xterm';

/*
 * Буфер обмена для командной строки.
 *
 * Вставлять — только через terminal.paste(), а не отправкой текста как
 * набранного: paste() оборачивает текст в метки «это вставка» (bracketed
 * paste), если программа их просит, и приводит переводы строк к виду
 * терминала. Без этого многострочный текст в оболочке выполняется построчно
 * прямо при вставке, а Клод в терминале принимает каждую строку за отдельное
 * сообщение.
 *
 * На телефоне чтение буфера браузер может не дать (нет разрешения, старый
 * Safari). Тогда открывается окно с полем ввода: в него вставляют привычным
 * долгим нажатием, и текст уходит в терминал кнопкой. Окно рисует панель
 * клавиш — сюда она подписывается через событие.
 */

export const TERMINAL_PASTE_SHEET_EVENT = 'ccui:terminal-paste-sheet';

export type TerminalPasteSheetDetail = {
  terminal: Terminal;
};

export function requestTerminalPasteSheet(terminal: Terminal): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<TerminalPasteSheetDetail>(TERMINAL_PASTE_SHEET_EVENT, {
      detail: { terminal },
    }),
  );
}

/** Вставить текст из буфера. false — буфер прочитать не дали. */
export async function pasteClipboardIntoTerminal(terminal: Terminal): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
    return false;
  }

  try {
    const text = await navigator.clipboard.readText();
    if (text.length > 0) {
      terminal.paste(text);
    }
    return true;
  } catch {
    return false;
  }
}

/** Вставить из буфера, а если не вышло — открыть окно ручной вставки. */
export function pasteOrOpenSheet(terminal: Terminal): void {
  void pasteClipboardIntoTerminal(terminal).then((pasted) => {
    if (!pasted) {
      requestTerminalPasteSheet(terminal);
    }
  });
}

/**
 * Весь текст терминала обычным текстом: перенесённые по ширине экрана строки
 * склеиваются обратно, пустой хвост под курсором отрезается.
 */
export function getTerminalPlainText(terminal: Terminal, maxLines = 3000): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];

  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) {
      continue;
    }
    // Пробел на стыке переноса — часть текста: у строки, которая продолжается
    // на следующей, хвост не обрезаем.
    const continues = buffer.getLine(index + 1)?.isWrapped === true;
    const text = line.translateToString(!continues);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return lines.slice(-maxLines).join('\n');
}
