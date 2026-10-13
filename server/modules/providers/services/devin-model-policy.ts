/**
 * Персональные белые списки моделей Devin.
 *
 * Егор 06.10.26: Розе Гатиевой (web user 110) оставить только
 * High / SWE Medium / Max — остальные модели не должны ни
 * показываться в выборе, ни запускаться прямым вызовом API
 * или устаревшим состоянием composer'а.
 *
 * Политика — отдельным модулем, чтобы её видели все точки входа:
 * HTTP-маршруты (каталог и active-model), сервис моделей (запись и
 * чтение модели сессии) и websocket (модель из composer'а в момент
 * отправки — до того, как у сессии появилась строка в базе).
 */
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const DEVIN_RESTRICTED_DEFAULT_MODEL = 'swe-2-high';

const DEVIN_MODEL_ALLOWLIST_BY_USER_ID: ReadonlyMap<number, ReadonlySet<string>> = new Map([
  // Гатиева Роза — web user 110.
  [110, new Set(['swe-2-high', 'swe-2-medium', 'swe-2-max'])],
]);

const toNumericUserId = (userId: unknown): number | null => {
  if (typeof userId !== 'number' && typeof userId !== 'string') {
    return null;
  }
  const numeric = Number(userId);
  return Number.isFinite(numeric) ? numeric : null;
};

/** Белый список моделей Devin пользователя; null — пользователь не ограничен. */
export const devinModelAllowlistForUser = (userId: unknown): ReadonlySet<string> | null => {
  const numeric = toNumericUserId(userId);
  return numeric === null ? null : (DEVIN_MODEL_ALLOWLIST_BY_USER_ID.get(numeric) ?? null);
};

/**
 * Приводит модель к разрешённой: значение вне белого списка (или отсутствие
 * значения) заменяется дефолтом ограниченного набора. Для других провайдеров
 * и неограниченных пользователей возвращает модель без изменений.
 */
export const clampDevinModelForUser = (
  provider: LLMProvider | string,
  userId: unknown,
  model?: string | null,
): string | null | undefined => {
  if (provider !== 'devin') {
    return model;
  }
  const allowlist = devinModelAllowlistForUser(userId);
  if (!allowlist) {
    return model;
  }
  return typeof model === 'string' && allowlist.has(model.trim())
    ? model
    : DEVIN_RESTRICTED_DEFAULT_MODEL;
};

/**
 * Каталог моделей для ограниченного пользователя: OPTIONS фильтруются белым
 * списком, DEFAULT приводится к swe-2-high (или первой доступной).
 */
export const applyDevinModelAllowlistToCatalog = (
  provider: LLMProvider | string,
  userId: unknown,
  models: ProviderModelsDefinition,
): ProviderModelsDefinition => {
  const allowlist = provider === 'devin' ? devinModelAllowlistForUser(userId) : null;
  if (!allowlist) {
    return models;
  }
  const options = models.OPTIONS.filter((option) => allowlist.has(option.value));
  return {
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === DEVIN_RESTRICTED_DEFAULT_MODEL)
      ? DEVIN_RESTRICTED_DEFAULT_MODEL
      : (options[0]?.value ?? models.DEFAULT),
  };
};

/**
 * Ограниченному пользователю нельзя править общий каталог custom-моделей:
 * созданная ею запись стала бы видна всем, а работать всё равно не стала бы.
 */
export const assertDevinModelCatalogWritable = (
  provider: LLMProvider | string,
  userId: unknown,
): void => {
  if (provider === 'devin' && devinModelAllowlistForUser(userId)) {
    throw new AppError('Model catalog is restricted for this account.', {
      code: 'DEVIN_MODEL_CATALOG_RESTRICTED',
      statusCode: 403,
    });
  }
};
