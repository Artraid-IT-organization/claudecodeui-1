import { useTranslation } from 'react-i18next';
import { CircleAlert, CircleStop, Unplug } from 'lucide-react';

import type { RunOutcome } from '../../../../stores/useSessionStore';

type RunOutcomeBannerProps = {
  outcome: RunOutcome;
};

/**
 * Плашка «чем кончился последний ход» под лентой чата.
 *
 * Зачем. Исход хода раньше был живым событием в сокете: пропустил его —
 * и лента навсегда выглядела замершей посреди работы (14.10.26: iPhone
 * выгрузил страницу, а ход тем временем умер на лимите модели — полтора
 * часа человек смотрел на тишину). Сервер пишет исход каждого хода в
 * журнал и отдаёт его подпиской/рассылкой run_terminal; эта плашка —
 * видимый терминальный статус, которого раньше не было.
 *
 * Показываем только неуспех: «completed» плашкой не нужен, новый ход
 * снимает её сам (chat_run_started → setRunOutcome(null)).
 */
export function RunOutcomeBanner({ outcome }: RunOutcomeBannerProps) {
  const { t } = useTranslation('chat');

  const finishedAt = outcome.finishedAt ? new Date(outcome.finishedAt) : null;
  const timeLabel = finishedAt && !Number.isNaN(finishedAt.getTime())
    ? finishedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null;

  const title = outcome.status === 'aborted'
    ? t('runOutcome.aborted', { defaultValue: 'Ход остановлен' })
    : outcome.status === 'interrupted'
      ? t('runOutcome.interrupted', { defaultValue: 'Ход прерван перезапуском сервера' })
      : t('runOutcome.failed', { defaultValue: 'Ход завершился с ошибкой' });

  const Icon = outcome.status === 'aborted'
    ? CircleStop
    : outcome.status === 'interrupted'
      ? Unplug
      : CircleAlert;

  return (
    <div
      role="status"
      className="mx-auto mb-1 flex w-full max-w-3xl items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-[13px] leading-snug text-foreground"
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0">
        <div className="font-medium">
          {title}
          {timeLabel ? <span className="font-normal text-muted-foreground"> · {timeLabel}</span> : null}
        </div>
        {outcome.error ? (
          <div className="mt-0.5 break-words text-muted-foreground">{outcome.error}</div>
        ) : null}
      </div>
    </div>
  );
}
