/**
 * Привязка проекта и память последнего мозга папки.
 *
 * Егор 26.10.26: вкладка «Промпты» (/home/claude/prompts) живёт в разделе
 * Devin, и ничего в ней само не запускается на Claude — по умолчанию там
 * работает Devin/SWE, как раньше. Claude включается только явным выбором
 * модели в меню чата. Папка при этом запоминает последнюю использованную
 * пару «помощник+модель»: новый чат наследует её от самого свежего чата
 * папки; обычные чаты вне папки пользуются своим глобальным выбором.
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

export type ProjectBrainHint = {
  provider: string;
  model: string | null;
}

/**
 * Пара «помощник+модель», под которой создаётся новая сессия проекта.
 * В привязанной папке чат наследует последнюю использованную там пару
 * (переданную caller'ом из самого свежего чата папки): выбранный когда-то
 * Claude продолжает работать в следующих чатах, пока не выберут Devin.
 * Наследуемое значение вне разрешённой пары claude|devin и чужая модель
 * (не из каталога унаследованного помощника) отбрасываются. Без истории —
 * запрошенный клиентом провайдер (глобальный выбор composer'а).
 */
export const resolvePinnedProjectBrain = (
  projectPath: string,
  requestedProvider: LLMProvider,
  latest: ProjectBrainHint | null,
): { provider: LLMProvider; model: string | null } => {
  if (
    !PINNED_PROJECT_PROVIDERS.has(projectPath)
    || !latest
    || !PINNED_SWITCHABLE_PROVIDERS.has(latest.provider)
  ) {
    return { provider: requestedProvider, model: null };
  }
  const provider = latest.provider as LLMProvider;
  const model = latest.model && isValidModelForProvider(provider, latest.model)
    ? latest.model
    : null;
  return { provider, model };
};

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
