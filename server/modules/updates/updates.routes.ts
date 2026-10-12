/**
 * HTTP-роуты плашки «Обновить». Тонкие: разбор ввода → сервис → ответ.
 *
 *   GET  /api/updates/status   — есть ли пул и что с ним (опрос плашкой)
 *   POST /api/updates/apply    — применить пул целиком {id, force?}
 *   POST /api/updates/dismiss  — скрыть плашку до следующего пула {id}
 *   POST /api/updates/discuss  — открыть чат-разбор (бриф первым сообщением)
 */
import express, { type Request, type Response } from 'express';

import {
  dismissUpdate,
  getUpdateStatus,
  openDiscussChat,
  restoreDismissedUpdate,
  startApply,
  type UpdateStatus,
} from '@/modules/updates/updates.service.js';
import { getRequestRuntimeContext } from '@/shared/request-context.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

function readUpdateId(body: unknown): string {
  const value = (body as Record<string, unknown> | null)?.id;
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('не указано обновление (id)', { statusCode: 400 });
  }
  return value.trim();
}

router.get(
  '/status',
  asyncHandler(async (_req: Request, res: Response) => {
    const status: UpdateStatus = getUpdateStatus();
    res.json(createApiSuccessResponse(status));
  }),
);

router.post(
  '/apply',
  asyncHandler(async (req: Request, res: Response) => {
    const updateId = readUpdateId(req.body);
    const force = (req.body as Record<string, unknown> | null)?.force === true;
    const result = startApply(updateId, force);
    res.status(202).json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/dismiss',
  asyncHandler(async (req: Request, res: Response) => {
    const updateId = readUpdateId(req.body);
    const restore = (req.body as Record<string, unknown> | null)?.restore === true;
    const result = restore ? restoreDismissedUpdate(updateId) : dismissUpdate(updateId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/discuss',
  asyncHandler(async (_req: Request, res: Response) => {
    const userId = getRequestRuntimeContext()?.userId;
    const result = openDiscussChat(userId !== null && userId !== undefined ? String(userId) : null);
    res.status(201).json(createApiSuccessResponse(result));
  }),
);

export default router;
