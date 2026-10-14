export {
  WS_OPEN_STATE,
  connectedClients,
  clientUserIds,
  canReceiveProviderEvents,
  broadcastRealtimeEvent,
} from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
// dispatchChatQueues: серверная очередь сообщений чата — вызывается из server/index.ts,
// когда закончил агент, переживший перезапуск сайта (своего конца хода у него нет).
export { dispatchChatQueues } from './services/chat-queue.service.js';
// listChatQueue / clearChatQueue: возврат к сообщению (providers/session-rewind.service)
// снимает очередь чата, чтобы конец остановленного хода не отправил её поверх обрезки.
export { clearChatQueue, listChatQueue } from './services/chat-queue.service.js';
// queueChatMessage: модуль обновлений (updates) отправляет бриф в чат-разбор
// серверной очередью — ход начинается без открытой вкладки.
export { queueChatMessage } from './services/chat-queue.service.js';
// reconcilePersistedRuns: сверка журнала chat_runs при старте — ходы
// «running» без живого процесса закрываются обрывом, недошедшие сообщения
// возвращаются в очередь (server/index.ts, после adoptSurvivors).
// startRunWatchdog: сторож — ход «running» с мёртвым процессом получает
// видимый терминальный статус, а не вечное молчание.
export { reconcilePersistedRuns, startRunWatchdog } from './services/chat-run-registry.service.js';
