import type { LLMProvider } from '../types/app';

/**
 * Корпоративный провайдер по умолчанию. Все аккаунты Cloud UI работают
 * через централизованный Devin Connection Layer — пользователю не нужно
 * выбирать провайдера или иметь собственные credentials. Переопределяется
 * сборочной переменной VITE_DEFAULT_PROVIDER.
 */
const VALID_PROVIDERS: readonly string[] = ['claude', 'cursor', 'codex', 'devin', 'opencode'];

const envProvider = import.meta.env.VITE_DEFAULT_PROVIDER;

export const DEFAULT_PROVIDER: LLMProvider =
  typeof envProvider === 'string' && VALID_PROVIDERS.includes(envProvider)
    ? (envProvider as LLMProvider)
    : 'devin';
