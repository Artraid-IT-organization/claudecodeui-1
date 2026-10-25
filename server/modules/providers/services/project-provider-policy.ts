/**
 * Привязка проекта к провайдеру.
 *
 * Егор 25.10.26: вкладка «Промпты» (/home/claude/prompts) всегда работает на
 * Claude — промпты генерирует умная модель, а значок Devin у чатов вкладки
 * вводил в заблуждение. Выбор провайдера в composer'е при этом глобальный
 * (devin), поэтому сервер подменяет провайдер в момент создания сессии:
 * чат сразу ложится под тем провайдером, под которым пойдёт первый ход.
 *
 * Политика — отдельным модулем, чтобы её видели обе точки входа:
 * создание сессии (provider routes → sessions.service) и отправка сообщения
 * (websocket — приводит модель чужого провайдера, которую composer прислал
 * до синхронизации с провайдером свежесозданной сессии).
 */
import type { LLMProvider } from '@/shared/types.js';

import { CLAUDE_PREDEFINED_MODELS } from '../list/claude/claude-models.provider.js';

type PinnedProject = {
  provider: LLMProvider;
  /**
   * Модель, которой заменяется значение, недопустимое для привязанного
   * провайдера (например 'swe-2-high', присланное composer'ом до того, как он
   * переключился на свежую claude-сессию). Осознанный выбор допустимой модели
   * проходит как есть — привязка задаёт провайдера, а не модель.
   */
  fallbackModel: string;
};

const PINNED_PROJECTS: ReadonlyMap<string, PinnedProject> = new Map([
  ['/home/claude/prompts', { provider: 'claude', fallbackModel: 'opus' }],
]);

const CLAUDE_MODEL_VALUES: ReadonlySet<string> = new Set(
  CLAUDE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value),
);

const isValidModelForProvider = (provider: LLMProvider, model: string): boolean => {
  if (provider === 'claude') {
    return CLAUDE_MODEL_VALUES.has(model);
  }
  return true;
};

/**
 * Провайдер, под которым должна создаваться сессия в этом проекте:
 * привязанный, либо запрошенный клиентом, если привязки нет.
 */
export const resolveProjectProvider = (
  projectPath: string,
  provider: LLMProvider,
): LLMProvider => PINNED_PROJECTS.get(projectPath)?.provider ?? provider;

/**
 * Приводит модель к допустимой для привязанного провайдера: значение чужого
 * провайдера (устаревший выбор composer'а до открытия свежей сессии) заменяется
 * запасной моделью привязки. Вне привязанных проектов модель не трогается.
 */
export const clampProjectProviderModel = (
  provider: LLMProvider | string,
  projectPath: string | null,
  model?: string | null,
): string | null | undefined => {
  const pin = projectPath ? PINNED_PROJECTS.get(projectPath) : undefined;
  if (!pin || provider !== pin.provider) {
    return model;
  }
  return typeof model === 'string' && model.trim() && isValidModelForProvider(provider, model.trim())
    ? model
    : pin.fallbackModel;
};
