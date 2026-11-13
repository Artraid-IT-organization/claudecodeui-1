import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSelectedChatProvider } from '../../../../hooks/useCodexAccount';
import { api } from '../../../../utils/api';

import { UsageLimitsView, type UsageLimitsPayload } from './UsageLimitsView';

/**
 * Сервер берёт проценты у Anthropic (как `/usage`) и держит их минуту,
 * поэтому раз в две минуты — достаточно свежо и без лишних запросов.
 */
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const EMPTY_RETRY_INTERVAL_MS = 30 * 1000;

// Показываем только два окна: пятичасовое и недельное. Лимит конкретной модели
// Егору не нужен («лимиты fable не нужно показывать, а вот 7 дней и 5 часов
// нужны»); сервер отдаёт все окна — отбор дело показа, а не источника.
const VISIBLE_KINDS = ['session', 'weekly_all'];
/**
 * Лимиты подписки Claude: окно на пять часов и недельное — как `/usage`.
 *
 * Числа даёт сервер (`GET /api/user/usage-limits`: официальный запрос по входу
 * именно этого пользователя, запасной путь — кэш CLI). Окно, которое уже
 * сбросилось, не показывается вовсе: лучше ничего, чем неверное число.
 * Показывается только при выбранном Claude — у Devin и Codex таких окон нет.
 */
export default function SidebarUsageLimits() {
  const { t } = useTranslation('sidebar');
  const [payload, setPayload] = useState<UsageLimitsPayload | null>(null);
  // Лимиты есть только у подписки Claude: у Devin и Codex своих окон нет, и
  // чужой помощник не должен показывать цифры Claude как свои.
  const isClaudeSelected = useSelectedChatProvider() === 'claude';

  const load = useCallback(async () => {
    try {
      const response = await api.user.usageLimits();
      if (!response.ok) {
        return;
      }
      setPayload((await response.json()) as UsageLimitsPayload);
    } catch {
      // Расход — справочная величина: молчаливый пропуск лучше, чем ошибка
      // на весь экран из-за неё.
    }
  }, []);

  const rows = (payload?.limits ?? []).filter(
    (limit) => !limit.expired && VISIBLE_KINDS.includes(limit.kind),
  );
  const hasRows = rows.length > 0;

  useEffect(() => {
    void load();
  }, [load]);

  // Пусто — значит, ключ входа аккаунта просрочен (аккаунт долго простаивал) и
  // сервер не вправе его продлить. Ключ обновится сам с первым сообщением, и
  // тогда панель должна появиться за секунды, а не через две минуты.
  useEffect(() => {
    const timer = window.setInterval(
      () => void load(),
      hasRows ? REFRESH_INTERVAL_MS : EMPTY_RETRY_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [load, hasRows]);

  // Телефон усыпляет таймеры свёрнутого приложения: без этого после
  // возвращения на экран висит ответ, полученный до сна.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  if (!isClaudeSelected || !hasRows) {
    return null;
  }

  return <UsageLimitsView rows={rows} fetchedAtMs={payload?.fetchedAtMs ?? null} t={t} />;
}
