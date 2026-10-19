/**
 * Сервис оценок формата ответов: валидация ввода и вызов репозитория.
 *
 * Контракт повторён из референса ~/response-format-memory:
 * direction — 'like' | 'dislike' → ±1; category — фиксированный список причин
 * дизлайка; comment — до 2000 символов. domain и format_hash приходят
 * посчитанными от клиента (в боевом чате у сервера нет текста сообщения в
 * базе), поэтому здесь только ограничивается их размер.
 */
import {
  messageFeedbackDb,
  type MessageFeedbackRow,
} from '@/modules/database/index.js';

export const FEEDBACK_CATEGORIES = new Set([
  'too_long',
  'too_short',
  'wrong_structure',
  'missing_table',
  'too_verbose',
  'unclear',
  'custom',
]);

export type FeedbackDirection = 'like' | 'dislike';

export type SaveFeedbackInput = {
  messageId: string;
  sessionId?: unknown;
  userId: number | null;
  direction: FeedbackDirection;
  category?: unknown;
  comment?: unknown;
  domain?: unknown;
  formatHash?: unknown;
};

/** Ошибка ввода клиента — роут переводит её в 400. */
export class FeedbackValidationError extends Error {}

const optionalText = (value: unknown, max: number, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new FeedbackValidationError(`${field} должен быть строкой`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new FeedbackValidationError(`${field} длиннее ${max} символов`);
  return trimmed;
};

export function saveMessageFeedback(input: SaveFeedbackInput): MessageFeedbackRow {
  const direction = input.direction === 'like' ? 1 : -1;
  const category = optionalText(input.category, 32, 'category');
  if (category !== null && !FEEDBACK_CATEGORIES.has(category)) {
    throw new FeedbackValidationError('неизвестная категория');
  }
  if (direction === -1 && category === null) {
    throw new FeedbackValidationError('для дизлайка нужна категория');
  }

  return messageFeedbackDb.upsert({
    messageId: input.messageId,
    sessionId: optionalText(input.sessionId, 200, 'sessionId'),
    userId: input.userId,
    direction,
    category,
    comment: optionalText(input.comment, 2000, 'comment'),
    domain: optionalText(input.domain, 32, 'domain'),
    formatHash: optionalText(input.formatHash, 64, 'format_hash'),
  });
}

/** Удаляет оценку — отмена голоса повторным кликом. */
export function removeMessageFeedback(messageId: string, userId: number): boolean {
  return messageFeedbackDb.remove(messageId, userId);
}

export function listSessionFeedback(sessionId: string, userId: number): MessageFeedbackRow[] {
  return messageFeedbackDb.listBySession(sessionId, userId);
}
