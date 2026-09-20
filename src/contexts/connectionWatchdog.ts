/**
 * Решение сторожа связи: что делать с текущим сокетом.
 *
 * Вынесено из `WebSocketContext` отдельной функцией ровно потому, что это
 * единственное место, где решается судьба связи, — и его надо проверять
 * тестом, а не глазами. Сам контекст живёт в React и без DOM не запускается;
 * решение — чистое и проверяется как таблица.
 *
 * - `ok` — соединение открыто, делать нечего;
 * - `connect` — сокета нет, открыть новый;
 * - `recreate` — сокет есть, но мёртв или не открывается: бросить и открыть
 *   новый, не дожидаясь `onclose` (у сокета, уснувшего в фоне, его может не
 *   прийти никогда);
 * - `wait` — подключение идёт или уже назначено, ждать.
 */
export type ConnectionAction = 'ok' | 'connect' | 'recreate' | 'wait';

/** Состояния сокета — числами, чтобы функция не зависела от DOM. */
export const SOCKET_STATE = {
  connecting: 0,
  open: 1,
  closing: 2,
  closed: 3,
} as const;

export type ConnectionSnapshot = {
  /** `null` — сокета нет вовсе. */
  readyState: number | null;
  /** Назначен ли повторный заход (таймер из `onclose`). */
  reconnectScheduled: boolean;
  /** Сколько миллисекунд длится текущее рукопожатие. */
  connectingForMs: number;
  /** Рукопожатие дольше этого — соединение не откроется уже никогда. */
  stallMs: number;
};

export const decideConnectionAction = ({
  readyState,
  reconnectScheduled,
  connectingForMs,
  stallMs,
}: ConnectionSnapshot): ConnectionAction => {
  if (readyState === null) {
    // Повтор уже назначен — второй заход создал бы лишнее соединение.
    return reconnectScheduled ? 'wait' : 'connect';
  }
  if (readyState === SOCKET_STATE.open) return 'ok';
  if (readyState === SOCKET_STATE.connecting) {
    return connectingForMs > stallMs ? 'recreate' : 'wait';
  }
  // CLOSING/CLOSED: назначенный повтор не ждём — он мог быть съеден вместе с
  // заснувшей вкладкой, а сокет в этом состоянии уже ничего не принесёт.
  return 'recreate';
};
