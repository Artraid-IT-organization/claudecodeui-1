/**
 * HTTP-роуты статуса подключения MacBook.
 *
 *   GET  /api/mac-status         — текущий JSON-статус
 *   GET  /api/mac-status/stream  — SSE-поток, пушит изменения
 */
import express, { type Request, type Response } from 'express';

import type { MacStatusService } from './mac-status.service.js';

export function createMacStatusRouter(service: MacStatusService): express.Router {
  const router = express.Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json(service.getStatus());
  });

  router.get('/stream', (req: Request, res: Response) => {
    // Отключаем буферизацию nginx/proxy, иначе SSE будет задерживаться.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);

    service.addSseClient(res);

    req.on('close', () => {
      service.removeSseClient(res);
    });
  });

  return router;
}
