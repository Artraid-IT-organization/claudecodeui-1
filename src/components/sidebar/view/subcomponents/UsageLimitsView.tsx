import { cn } from '../../../../lib/utils';

export type UsageLimit = {
  kind: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  modelName: string | null;
  expired: boolean;
};

export type UsageLimitsPayload = {
  fetchedAtMs: number | null;
  limits: UsageLimit[];
};

/**
 * Позже этого возраста кэш считается несвежим и это подписывается.
 *
 * Полчаса было слишком строго: числа меняет сам CLI, и пока Егор не пишет в
 * чат, им неоткуда обновиться — подпись «данные не свежие» висела почти
 * всегда и обесценивала сама себя. Три часа — та граница, за которой внутри
 * пятичасового окна проценту действительно нельзя верить.
 */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

function formatResetsIn(resetsAt: string | null): string | null {
  if (!resetsAt) {
    return null;
  }
  const left = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(left) || left <= 0) {
    return null;
  }
  const minutes = Math.round(left / 60000);
  if (minutes < 60) {
    return `${minutes} мин`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} ч`;
  }
  return `${Math.round(hours / 24)} дн`;
}

type Translate = (key: string, options: { defaultValue: string; time?: string }) => string;

/** Только отрисовка: проценты и подписи готовы, сети и хуков здесь нет. */
export function UsageLimitsView({
  rows,
  fetchedAtMs,
  t,
}: {
  rows: UsageLimit[];
  fetchedAtMs: number | null;
  t: Translate;
}) {
  const isStale = fetchedAtMs ? Date.now() - fetchedAtMs > STALE_AFTER_MS : false;

  const labelFor = (limit: UsageLimit): string => (
    limit.kind === 'session'
      ? t('usage.sessionShort', { defaultValue: '5 часов' })
      : t('usage.weeklyShort', { defaultValue: 'Неделя' })
  );

  // Места под чаты мало (Егор 14.10.26 убирал блок именно за это), поэтому
  // каждое окно — одна строка: название, полоса, процент, «через сколько
  // обновится». Подробное время сброса — во всплывающей подсказке.
  return (
    <div
      className="flex-shrink-0 space-y-1 border-b border-border/60 px-3 py-1.5"
      title={isStale ? t('usage.stale', { defaultValue: 'данные не свежие' }) : undefined}
    >
      {rows.map((limit) => {
        const resetsIn = formatResetsIn(limit.resetsAt);
        return (
          <div
            key={`${limit.kind}-${limit.modelName ?? ''}`}
            className="flex items-center gap-2 text-[11px]"
            title={resetsIn ? t('usage.resetsIn', { defaultValue: 'Обновится через {{time}}', time: resetsIn }) : undefined}
          >
            <span className="w-14 flex-shrink-0 text-foreground">{labelFor(limit)}</span>
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-[width]',
                  limit.severity === 'critical'
                    ? 'bg-destructive'
                    : limit.severity === 'warning'
                      ? 'bg-amber-500'
                      : 'bg-primary',
                )}
                style={{ width: `${limit.percent}%` }}
              />
            </div>
            <span className="w-8 flex-shrink-0 text-right tabular-nums text-muted-foreground">
              {limit.percent}%
            </span>
            <span className="w-9 flex-shrink-0 text-right tabular-nums text-muted-foreground/70">
              {resetsIn ?? ''}
            </span>
          </div>
        );
      })}
      {isStale && (
        <p className="text-[10px] text-muted-foreground/70">
          {t('usage.stale', { defaultValue: 'данные не свежие' })}
        </p>
      )}
    </div>
  );
}
