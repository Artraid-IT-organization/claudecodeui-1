import { useTranslation } from 'react-i18next';
import { ActivityIcon } from 'lucide-react';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// Доля окна, с которой кнопка меняет цвет: жёлтым — пора думать о новом чате,
// красным — Claude скоро сожмёт разговор сам.
const CONTEXT_WARN_PERCENT = 70;
const CONTEXT_DANGER_PERCENT = 90;

export default function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation('chat');
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  // `used` — заполненность контекста, `total` — окно модели (сервер и живой
  // `token_budget` шлют оба). Окно известно — кнопка показывает долю, как
  // строка состояния терминального Claude Code; нет — прежний вид.
  const contextWindow = readUsageNumber(usage?.total);
  const hasWindow = contextWindow > 0 && usedTokens > 0;
  const percent = hasWindow ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0;
  const toneClass = !hasWindow || percent < CONTEXT_WARN_PERCENT
    ? 'text-foreground'
    : percent < CONTEXT_DANGER_PERCENT
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-red-600 dark:text-red-400';
  const title = hasWindow
    ? t('input.contextUsed', {
      used: usedTokens.toLocaleString('ru-RU'),
      total: contextWindow.toLocaleString('ru-RU'),
      percent,
      defaultValue: `Контекст занят: ${usedTokens.toLocaleString('ru-RU')} из ${contextWindow.toLocaleString('ru-RU')} (${percent}%)`,
    })
    : t('input.tokensUsed', { count: usedTokens, defaultValue: `Израсходовано токенов: ${usedTokens.toLocaleString('ru-RU')}` });

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={title}
      aria-label={t('input.showTokenUsage', { defaultValue: 'Показать расход токенов' })}
      data-context-percent={hasWindow ? percent : undefined}
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      {hasWindow ? (
        <>
          {/* На телефоне — только доля: полные числа вытесняли соседние кнопки. */}
          <span className={`font-medium ${toneClass}`}>{percent}%</span>
          <span className="hidden text-muted-foreground/70 sm:inline">
            {formatTokenCount(usedTokens)}/{formatTokenCount(contextWindow)}
          </span>
        </>
      ) : (
        <>
          <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
          <span className="hidden text-muted-foreground/70 sm:inline">{t('input.tokensShort', { defaultValue: 'токенов' })}</span>
        </>
      )}
    </button>
  );
}
