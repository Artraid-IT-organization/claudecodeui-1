import { useEffect, useState } from 'react';
import { Wifi, WifiOff } from 'lucide-react';

import { useWebSocket } from '../../../../contexts/WebSocketContext';
import { Tooltip } from '../../../../shared/view/ui';

/**
 * Маленький индикатор связи в шапке.
 *
 * Раньше пользователь просто видел, что «сайт не отвечает», и не понимал —
 * то ли связь потеряна, то ли сервер завис, то ли надо перегружать вкладку.
 * Индикатор превращает эту тишину в честную подпись: «связь есть», «нет
 * связи, переподключаюсь», «сервер молчит уже 15 секунд». Всё держится на
 * существующем `isConnected` — новых слоёв связи не добавляем.
 *
 * Пока связь есть — точка спокойного оттенка и почти незаметна: не отвлекает.
 * Как только исчезла — точка становится красной и рядом появляется счётчик,
 * сколько секунд назад разорвало. Секунды честнее, чем «offline» — сразу
 * понятно, действительно ли проблема надолго или это моргнуло.
 */
type Props = {
  /** Идёт ли сейчас запуск агента в открытом разговоре. */
  isProcessing?: boolean;
};

export default function ConnectionStatus({ isProcessing = false }: Props) {
  const { isConnected } = useWebSocket();
  const [droppedAt, setDroppedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (isConnected) {
      setDroppedAt(null);
      return;
    }
    // Отсчёт стартует ровно с момента разрыва, а не с монтирования: если
    // компонент подмонтирован уже после отвала, пользователь всё равно увидит,
    // сколько прошло.
    if (droppedAt === null) setDroppedAt(Date.now());
  }, [isConnected, droppedAt]);

  useEffect(() => {
    if (isConnected) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isConnected]);

  const secondsOff = droppedAt ? Math.max(1, Math.round((Date.now() - droppedAt) / 1000)) : 0;
  // Подсчёт использует tick только чтобы компонент перерисовывался каждую секунду.
  void tick;

  if (isConnected) {
    return (
      <Tooltip content="Связь с сервером есть" position="bottom">
        <span
          aria-label="Связь с сервером есть"
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-emerald-500/70"
        >
          <Wifi className="h-3.5 w-3.5" />
        </span>
      </Tooltip>
    );
  }

  // Формат числа: до минуты — секунды, дальше — минуты, чтобы «уже 240 с» не
  // читалось как ошибка.
  const label =
    secondsOff < 60
      ? `${secondsOff} с`
      : `${Math.floor(secondsOff / 60)} мин ${secondsOff % 60} с`;

  /*
   * Связь пропала, но запуск при этом жив: он идёт на сервере и обрыв
   * переживает. Раньше в этот момент в ленту падало «ответ не получен,
   * отправьте ещё раз» — и человек отправлял, а повторный запуск вытеснял
   * первый, убивая ту самую работу, которую ждали. Теперь состояние
   * показывается здесь и говорит правду: связи нет, работа продолжается.
   */
  const hint = isProcessing
    ? `Нет связи ${label}, но работа продолжается на сервере. Ответ появится, когда связь вернётся — отправлять заново не нужно.`
    : `Нет связи с сервером ${label}. Пытаюсь подключиться каждые 3 секунды.`;

  return (
    <Tooltip content={hint} position="bottom">
      <span
        aria-label={hint}
        className={
          isProcessing
            ? 'flex flex-shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400'
            : 'flex flex-shrink-0 items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500'
        }
      >
        <WifiOff className="h-3.5 w-3.5" />
        <span className="tabular-nums">{label}</span>
        {isProcessing && <span className="whitespace-nowrap">· работа идёт</span>}
      </span>
    </Tooltip>
  );
}
