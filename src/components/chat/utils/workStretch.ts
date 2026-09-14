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
 *
 * Какие из мыслей показать, решает не этот файл, а разбор по смыслу при
 * раскрытии (WorkStretchContainer → /api/user/thought-digest): важные этапы
 * видны все, сколько бы их ни было, рабочие мелочи — нет.
 */
export interface WorkStretchItem {
  _isStretch: true;
  messages: ChatMessage[];
  /** Все непустые мысли свёртки по порядку — кандидаты на показ. */
  thoughts: ChatMessage[];
  actionCount: number;
  /** Сколько действий завершилось ошибкой — в свёрнутой строке это видно сразу. */
  errorCount: number;
  timestamp: ChatMessage['timestamp'];
}

/**
 * Мысль, которую есть смысл отдавать на разбор: не пустая и не служебная
 * короткая реплика («жду», «проверю»). Язык не важен — модель размышляет
 * по-английски, на русский переводит разбор.
 *
 * Потолка в три мысли больше нет. Егор 14.09.26: «если он думал несколько
 * часов, пусть распишет каждый пункт, который важный, ценный — этап какой-то,
 * research закончил, критику запустил. Это я хочу видеть. До этого он писал
 * абсолютно всё, и это было лишним».
 */
export function isReadableThought(message: ChatMessage): boolean {
  if (!message.isThinking || isEmptyThinking(message)) return false;
  const letters = String(message.content ?? '').match(/\p{L}/gu) ?? [];
  return letters.length >= 20;
}

/** Текст уже по-русски — переводить не нужно. */
export function isMostlyRussian(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const cyrillic = letters.filter((ch) => /[Ѐ-ӿ]/.test(ch)).length;
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

export function groupWorkStretches<T extends ChatMessage>(messages: T[]): Array<T | WorkStretchItem> {
  const items: Array<T | WorkStretchItem> = [];
  let run: T[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const actionCount = run.filter((message) => message.isToolUse).length;
    const errorCount = run.filter((message) => message.isToolUse && message.toolResult?.isError).length;
    const thoughts = run.filter(isReadableThought);
    // Только пустые размышления — показывать нечего, ни строки, ни свёртки.
    if (actionCount > 0 || thoughts.length > 0) {
      items.push({
        _isStretch: true,
        messages: run,
        thoughts,
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

/**
 * Подпись свёрнутой строки: «Ход работы · 5 этапов · 9 действий · 1 ошибка».
 *
 * Число этапов известно только после разбора; до него строка честно говорит
 * «размышления», а не число сырых мыслей, которых покажется меньше.
 */
export function describeWorkStretch(item: {
  actionCount: number;
  errorCount?: number;
  /** Сколько важных этапов нашёл разбор; undefined — разбора ещё не было. */
  stageCount?: number;
  hasThoughts?: boolean;
}): string {
  const parts = ['Ход работы'];
  if (typeof item.stageCount === 'number') {
    if (item.stageCount > 0) parts.push(`${item.stageCount} ${pluralRu(item.stageCount, 'этап', 'этапа', 'этапов')}`);
  } else if (item.hasThoughts && item.actionCount === 0) {
    parts.push('размышления');
  }
  if (item.actionCount > 0) {
    parts.push(`${item.actionCount} ${pluralRu(item.actionCount, 'действие', 'действия', 'действий')}`);
  }
  const errors = item.errorCount ?? 0;
  if (errors > 0) parts.push(`${errors} ${pluralRu(errors, 'ошибка', 'ошибки', 'ошибок')}`);
  return parts.join(' · ');
}

/**
 * Что показать внутри раскрытого «Хода работы»: показываемые мысли и шаги по
 * порядку, подряд идущие одинаковые действия — одной строкой.
 *
 * Мысли передаются в склейку как ВИДИМЫЕ. Первая версия звала склейку с
 * «размышления скрыты», и та пропускала мысли между действиями как невидимые:
 * подпись обещала «19 мыслей», а раскрытая свёртка показывала одни действия
 * (снимок живой страницы 13.09.26).
 */
export function workStretchRows(
  stretch: Pick<WorkStretchItem, 'messages'>,
  shownThoughts: ReadonlySet<ChatMessage>,
): MessageListItem[] {
  const visible = stretch.messages.filter((message) => !message.isThinking || shownThoughts.has(message));
  return groupConsecutiveTools(visible, true);
}
