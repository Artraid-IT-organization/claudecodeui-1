/**
 * Оценки формата ответов ассистента.
 *
 * PUT  /api/messages/:messageId/feedback {direction, category?, comment?, domain?, format_hash?, sessionId?}
 *      — идемпотентно создать/изменить оценку (upsert по message_id, ответ
 *      содержит revision). Повторный клик переписывает ту же строку.
 * GET  /api/messages/feedback?sessionId=<id> — оценки сессии текущего
 *      пользователя: лента восстанавливает нажатое состояние кнопок.
 *
 * Хранение см. `database/repositories/message-feedback.ts`.
 */
import express from 'express';

import {
  FeedbackValidationError,
  listSessionFeedback,
  saveMessageFeedback,
  type FeedbackDirection,
} from '@/modules/message-feedback/message-feedback.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

const router = express.Router();

function readUserId(req: express.Request): number | null {
  const id = Number((req as AuthenticatedRequest).user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/feedback', (req, res) => {
  const userId = readUserId(req);
  if (userId === null) return res.status(401).json({ error: 'нет пользователя' });
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
  if (!sessionId) return res.status(400).json({ error: 'нужен sessionId' });
  try {
    const items = listSessionFeedback(sessionId, userId).map((row) => ({
      message_id: row.messageId,
      direction: row.direction === 1 ? 'like' : 'dislike',
      category: row.category,
      revision: row.revision,
    }));
    return res.json({ success: true, items });
  } catch (error) {
    console.error('Не удалось прочитать оценки сообщений:', error);
    return res.status(500).json({ error: 'Не удалось прочитать оценки' });
  }
});

router.put('/:messageId/feedback', (req, res) => {
  const userId = readUserId(req);
  if (userId === null) return res.status(401).json({ error: 'нет пользователя' });
  const messageId = String(req.params.messageId || '').trim();
  if (!messageId || messageId.length > 200) {
    return res.status(400).json({ error: 'нужен message_id' });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const direction = body.direction;
  if (direction !== 'like' && direction !== 'dislike') {
    return res.status(400).json({ error: 'direction должен быть like или dislike' });
  }
  try {
    const row = saveMessageFeedback({
      messageId,
      sessionId: body.sessionId,
      userId,
      direction: direction as FeedbackDirection,
      category: body.category,
      comment: body.comment,
      domain: body.domain,
      formatHash: body.format_hash,
    });
    return res.json({
      message_id: row.messageId,
      direction: row.direction === 1 ? 'like' : 'dislike',
      revision: row.revision,
    });
  } catch (error) {
    if (error instanceof FeedbackValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Не удалось сохранить оценку сообщения:', error);
    return res.status(500).json({ error: 'Не удалось сохранить оценку' });
  }
});

export default router;
