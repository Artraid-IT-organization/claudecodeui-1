import fs from 'node:fs';
import os from 'node:os';
import { parentPort } from 'node:worker_threads';

import { createDevinDbCache, extractDevinBody } from '@/modules/providers/services/chat-search-devin-texts.js';

// Поток разбора переписки Devin для поискового индекса (см. chat-search-devin-texts.ts).
// Самый низкий приоритет только этому потоку (Linux: nice по id потока) —
// индекс подождёт, а сервер сайта и соседние службы получают процессор первыми.
try {
  const threadId = Number(fs.readlinkSync('/proc/thread-self').split('/').pop());
  if (Number.isInteger(threadId) && threadId > 0) os.setPriority(threadId, 19);
} catch {
  // не Linux или нет /proc — работаем с обычным приоритетом
}

const openDb = createDevinDbCache();

parentPort?.on('message', (request: { id: number; dbPath: string; providerSessionId: string }) => {
  const text = extractDevinBody(openDb, request.dbPath, request.providerSessionId);
  parentPort?.postMessage({ id: request.id, text });
});
