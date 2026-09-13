import type { ChatMessage } from '../types/types';
import { groupConsecutiveTools, isEmptyThinking, type MessageListItem } from './toolGrouping';

/**
 * «Ход работы»: всё, что ИИ делал между сообщением человека и своим ответом,
 * одним свёрнутым элементом ленты.
 *
 * Егор 13.09.26 на ленту из десятков строк «Думал несколько секунд: I need to…»,
 * «Read / путь», «Bash / …»: «слишком много лишнего… посмотри как делает сам чат
 * Claude и как пишет VS Code… оставь описание только ключевых размышлений и
 * свёрнуто, описывай их на русском. Должно быть только то, что мне нужно знать в
 * размышлениях и то что он сделал, только нужные отчётности».
 *
 * Образец — Claude Code для VS Code и приложение Claude: работа идёт свёрнутыми
 * строками, а ответ модели — это и есть отчёт, он виден целиком. Здесь вся
 * работа между двумя «настоящими» сообщениями (текст человека, текст ответа,
 * ошибка, вопрос с кнопками) становится одним элементом.
 */
export interface WorkStretchItem {
  _isStretch: true;
  messages: ChatMessage[];
  keyThoughts: ChatMessage[];
  actionCount: number;
  timestamp: ChatMessage['timestamp'];
}

/**
 * Короче этого размышление считается служебным («сейчас проверю», «жду сборку»)
 * и в «ключевые» не попадает — оно не несёт того, что человеку нужно знать.
 */
export const KEY_THOUGHT_MIN_CHARS = 80;

export function isWorkStretchItem(item: unknown): item is WorkStretchItem {
  return Boolean(item && typeof item === 'object' && (item as WorkStretchItem)._isStretch === true);
}

function isWorkMessage(message: ChatMessage): boolean {
  if (message.isThinking) return true;
  // Запрос разрешения требует действия человека — он не прячется в свёртку.
  if (message.isToolUse && !message.isInteractivePrompt) return true;
  return false;
}

export function isKeyThought(message: ChatMessage): boolean {
  if (!message.isThinking || isEmptyThinking(message)) return false;
  return String(message.content ?? '').replace(/\s+/g, ' ').trim().length >= KEY_THOUGHT_MIN_CHARS;
}

export function groupWorkStretches<T extends ChatMessage>(messages: T[]): Array<T | WorkStretchItem> {
  const items: Array<T | WorkStretchItem> = [];
  let run: T[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const actionCount = run.filter((message) => message.isToolUse).length;
    const keyThoughts = run.filter(isKeyThought);
    // Только пустые размышления — показывать нечего, ни строки, ни свёртки.
    if (actionCount > 0 || keyThoughts.length > 0) {
      items.push({
        _isStretch: true,
        messages: run,
        keyThoughts,
        actionCount,
        timestamp: run[0].timestamp,
      });
    }
    run = [];
  };

  for (const message of messages) {
    if (isWorkMessage(message)) {
      run.push(message);
      continue;
    }
    flush();
    items.push(message);
  }
  flush();
  return items;
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Подпись свёрнутой строки: «Ход работы · 3 мысли · 9 действий». */
export function describeWorkStretch(item: Pick<WorkStretchItem, 'keyThoughts' | 'actionCount'>): string {
  const parts = ['Ход работы'];
  const thoughts = item.keyThoughts.length;
  if (thoughts > 0) parts.push(`${thoughts} ${pluralRu(thoughts, 'мысль', 'мысли', 'мыслей')}`);
  if (item.actionCount > 0) {
    parts.push(`${item.actionCount} ${pluralRu(item.actionCount, 'действие', 'действия', 'действий')}`);
  }
  return parts.join(' · ');
}

/**
 * Что показать внутри раскрытого «Хода работы»: ключевые мысли и шаги по порядку,
 * подряд идущие одинаковые действия — одной строкой.
 *
 * Мысли передаются в склейку как ВИДИМЫЕ. Первая версия звала склейку с
 * «размышления скрыты», и та пропускала мысли между действиями как невидимые:
 * подпись обещала «19 мыслей», а раскрытая свёртка показывала одни действия
 * (снимок живой страницы 13.09.26).
 */
export function workStretchRows(stretch: Pick<WorkStretchItem, 'messages'>): MessageListItem[] {
  const visible = stretch.messages.filter((message) => !message.isThinking || isKeyThought(message));
  return groupConsecutiveTools(visible, true);
}
