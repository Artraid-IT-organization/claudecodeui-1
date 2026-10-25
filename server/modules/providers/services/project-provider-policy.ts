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
import { PINNED_PROJECT_PROVIDERS } from '@/shared/utils.js';

import { CLAUDE_PREDEFINED_MODELS } from '../list/claude/claude-models.provider.js';

/**
 * Запасная модель привязки: ей заменяется значение, недопустимое для
 * привязанного провайдера (например 'swe-2-high', присланное composer'ом до
 * синхронизации со свежей claude-сессией). Осознанный выбор допустимой модели
 * проходит как есть — привязка задаёт провайдера, а не модель.
 */
const PINNED_FALLBACK_MODELS: ReadonlyMap<string, string> = new Map([
  ['/home/claude/prompts', 'opus'],
]);

const CLAUDE_MODEL_VALUES: ReadonlySet<string> = new Set(
  CLAUDE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value),
);

const isValidModelForProvider = (provider: LLMProvider | string, model: string): boolean => {
  if (provider === 'claude') {
    return CLAUDE_MODEL_VALUES.has(model);
  }
  return true;
};

/**
 * Помощники, между которыми в привязанном проекте разрешено переключаться
 * через меню моделей чата (Егор 25.10.26: во вкладке «Промпты» общий список —
 * и Claude, и Devin).
 */
const PINNED_SWITCHABLE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'devin']);

/**
 * Провайдер, под которым должна создаваться сессия в этом проекте:
 * привязанный, либо запрошенный клиентом, если привязки нет.
 */
export const resolveProjectProvider = (
  projectPath: string,
  provider: LLMProvider,
): LLMProvider => (PINNED_PROJECT_PROVIDERS.get(projectPath) as LLMProvider | undefined) ?? provider;

/**
 * Явный выбор помощника внутри чата привязанного проекта: клиент присылает
 * options.provider из объединённого меню моделей. Возвращает цель
 * переключения, если проект привязан, значение из разрешённой пары
 * claude|devin и отличается от текущего; иначе null — случайное или чужое
 * значение composer'а сессию не двигает.
 */
export const resolvePinnedSessionProvider = (
  projectPath: string | null,
  currentProvider: string,
  requestedProvider: string | null | undefined,
): LLMProvider | null => {
  if (!projectPath || !PINNED_PROJECT_PROVIDERS.has(projectPath) || !requestedProvider) {
    return null;
  }
  const target = requestedProvider.trim();
  return target !== currentProvider && PINNED_SWITCHABLE_PROVIDERS.has(target)
    ? (target as LLMProvider)
    : null;
};

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
  const pin = projectPath ? PINNED_PROJECT_PROVIDERS.get(projectPath) : undefined;
  if (!pin || provider !== pin) {
    return model;
  }
  return typeof model === 'string' && model.trim() && isValidModelForProvider(provider, model.trim())
    ? model
    : PINNED_FALLBACK_MODELS.get(projectPath!);
};
