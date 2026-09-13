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
  /** Сколько действий завершилось ошибкой — в свёрнутой строке это видно сразу. */
  errorCount: number;
  timestamp: ChatMessage['timestamp'];
}

/**
 * Сколько мыслей показывать в раскрытом «Ходе работы» — последние, то есть к
 * чему модель пришла перед ответом.
 */
export const KEY_THOUGHTS_LIMIT = 3;

/**
 * Мысль, которую стоит показать человеку: написана по-русски.
 *
 * Первая версия отбирала мысли по длине (от 80 символов), и на живой странице
 * раскрытая свёртка стала стеной из 22 длинных английских абзацев вроде «I've
 * created a branch feat/honest-phases…». Пересказ размышлений почти всегда
 * длинный, так что длина ничего не отсеивала. Егор просил «описывай их на
 * русском… только то, что мне нужно знать». Модели теперь при запуске велено
 * размышлять по-русски и только о важном — такие мысли и показываются, а
 * внутренняя английская кухня остаётся за кадром.
 */
export function isReadableThought(message: ChatMessage): boolean {
  if (!message.isThinking || isEmptyThinking(message)) return false;
  const letters = String(message.content ?? '').match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return false;
  const cyrillic = letters.filter((ch) => /[\u0400-\u04FF]/.test(ch)).length;
  return cyrillic / letters.length >= 0.5;
}

export function isWorkStretchItem(item: unknown): item is WorkStretchItem {
  return Boolean(item && typeof item === 'object' && (item as WorkStretchItem)._isStretch === true);
}

/**
 * Вызовы, которые человек должен увидеть сам, а не искать в свёртке: план на
 * утверждение и вопрос с вариантами ответа.
 */
const ALWAYS_VISIBLE_TOOLS = new Set(['ExitPlanMode', 'exit_plan_mode', 'AskUserQuestion']);

function isWorkMessage(message: ChatMessage): boolean {
  if (message.isThinking) return true;
  // Запрос разрешения требует действия человека — он не прячется в свёртку.
  if (message.isToolUse && !message.isInteractivePrompt && !ALWAYS_VISIBLE_TOOLS.has(String(message.toolName ?? ''))) {
    return true;
  }
  return false;
}

/** Ключевые мысли хода работы: русские, не больше последних KEY_THOUGHTS_LIMIT. */
export function selectKeyThoughts(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(isReadableThought).slice(-KEY_THOUGHTS_LIMIT);
}

export function groupWorkStretches<T extends ChatMessage>(messages: T[]): Array<T | WorkStretchItem> {
  const items: Array<T | WorkStretchItem> = [];
  let run: T[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const actionCount = run.filter((message) => message.isToolUse).length;
    const errorCount = run.filter((message) => message.isToolUse && message.toolResult?.isError).length;
    const keyThoughts = selectKeyThoughts(run);
    // Только пустые размышления — показывать нечего, ни строки, ни свёртки.
    if (actionCount > 0 || keyThoughts.length > 0) {
      items.push({
        _isStretch: true,
        messages: run,
        keyThoughts,
        actionCount,
        errorCount,
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

/** Подпись свёрнутой строки: «Ход работы · 3 мысли · 9 действий · 1 ошибка». */
export function describeWorkStretch(item: Pick<WorkStretchItem, 'keyThoughts' | 'actionCount'> & { errorCount?: number }): string {
  const parts = ['Ход работы'];
  const thoughts = item.keyThoughts.length;
  if (thoughts > 0) parts.push(`${thoughts} ${pluralRu(thoughts, 'мысль', 'мысли', 'мыслей')}`);
  if (item.actionCount > 0) {
    parts.push(`${item.actionCount} ${pluralRu(item.actionCount, 'действие', 'действия', 'действий')}`);
  }
  const errors = item.errorCount ?? 0;
  if (errors > 0) parts.push(`${errors} ${pluralRu(errors, 'ошибка', 'ошибки', 'ошибок')}`);
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
export function workStretchRows(stretch: Pick<WorkStretchItem, 'messages' | 'keyThoughts'>): MessageListItem[] {
  const keep = new Set(stretch.keyThoughts);
  const visible = stretch.messages.filter((message) => !message.isThinking || keep.has(message));
  return groupConsecutiveTools(visible, true);
}
