/**
 * Решение сторожа связи: что делать с текущим сокетом.
 *
 * Вынесено из `WebSocketContext` отдельной функцией ровно потому, что это
 * единственное место, где решается судьба связи, — и его надо проверять
 * тестом, а не глазами. Сам контекст живёт в React и без DOM не запускается;
 * решение — чистое и проверяется как таблица.
 *
 * - `ok` — соединение открыто и на связи, делать нечего;
 * - `connect` — сокета нет, открыть новый;
 * - `recreate` — сокет есть, но мёртв или не открывается: бросить и открыть
 *   новый, не дожидаясь `onclose` (у сокета, уснувшего в фоне, его может не
 *   прийти никогда);
 * - `probe` — сокет числится открытым, но сервер молчит дольше нормы:
 *   отправить лёгкий запрос и посмотреть, ответит ли соединение;
 * - `wait` — подключение или проба идут либо повтор назначен, ждать.
 */
export type ConnectionAction = 'ok' | 'connect' | 'recreate' | 'wait' | 'probe';

export const isConnectionStableFrame = (kind: string | undefined, serverPingMs: number | null) =>
  serverPingMs !== null && kind === 'server_ping';

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
  /**
   * Сколько миллисекунд сокет не получал ни одного кадра от сервера.
   * `null` — молчание не считаем (сервер старый, прикладных пингов нет).
   */
  silentForMs?: number | null;
  /** Молчание дольше этого при открытом сокете — подозрение на мёртвый путь. */
  silenceLimitMs?: number;
  /**
   * Сколько миллисекунд назад ушла проба (`type: 'ping'`). `null` — проба не
   * отправлена. Проба без ответа дольше `probeTimeoutMs` = путь мёртв.
   */
  probeAgeMs?: number | null;
  /** Сколько ждать ответ на пробу. */
  probeTimeoutMs?: number;
};

export const decideConnectionAction = ({
  readyState,
  reconnectScheduled,
  connectingForMs,
  stallMs,
  silentForMs = null,
  silenceLimitMs = Infinity,
  probeAgeMs = null,
  probeTimeoutMs = 4_000,
}: ConnectionSnapshot): ConnectionAction => {
  if (readyState === null) {
    // Повтор уже назначен — второй заход создал бы лишнее соединение.
    return reconnectScheduled ? 'wait' : 'connect';
  }
  if (readyState === SOCKET_STATE.open) {
    // Открытый, но молчащий сокет — полумёртвый путь (сеть сменилась или её
    // «заморозили» в середине): onclose в таком случае не приходит никогда,
    // а сервер уже не достучится. Сначала проба — вдруг сервер просто был
    // занят; проба без ответа — пересоздаём, попутно сменив вход.
    if (silentForMs !== null && silentForMs > silenceLimitMs) {
      if (probeAgeMs === null) return 'probe';
      return probeAgeMs > probeTimeoutMs ? 'recreate' : 'wait';
    }
    return 'ok';
  }
  if (readyState === SOCKET_STATE.connecting) {
    return connectingForMs > stallMs ? 'recreate' : 'wait';
  }
  // CLOSING/CLOSED: назначенный повтор не ждём — он мог быть съеден вместе с
  // заснувшей вкладкой, а сокет в этом состоянии уже ничего не принесёт.
  return 'recreate';
};
