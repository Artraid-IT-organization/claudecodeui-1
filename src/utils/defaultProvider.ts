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

/**
 * Разовый принудительный сброс выбора провайдера на корпоративный.
 * Срабатывает один раз на браузер при загрузке модуля: у вошедших до
 * смены корп-провайдера в localStorage стоял 'claude' и UI упирался в
 * мёртвую авторизацию. Дальнейший ручной выбор пользователя сохраняется —
 * флаг миграции не трогается.
 */
const MIGRATION_FLAG = 'corp-provider-migrated-v1';
try {
  if (!localStorage.getItem(MIGRATION_FLAG)) {
    localStorage.setItem('selected-provider', DEFAULT_PROVIDER);
    localStorage.setItem(MIGRATION_FLAG, '1');
  }
} catch {
  /* нет localStorage (SSR/тесты) — миграция не нужна */
}
