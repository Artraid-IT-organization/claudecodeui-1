/**
 * HTTP-роуты «Продолжить в новом чате».
 *
 * POST ставит задачу собрать выжимку чата и сразу отвечает: модель пишет её
 * до пары минут, а прокси и телефон столько не держат запрос. GET отдаёт
 * состояние задачи — кнопка опрашивает его, пока выжимка не готова.
 * Всё в рамках аккаунта запроса: чужой чат не найти и не прочитать.
 */
import express from 'express';

import { getHandoff, HandoffError, startHandoff, type HandoffJob } from '@/modules/handoff/handoff.service.js';

const router = express.Router();

function present(job: HandoffJob) {
  return {
    success: true,
    status: job.status,
    message: job.status === 'done' ? job.message : undefined,
    error: job.status === 'error' ? job.error : undefined,
    projectPath: job.projectPath ?? null,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
  };
}

router.post('/:sessionId', async (req, res) => {
  try {
    const job = await startHandoff(String(req.params.sessionId));
    return res.status(202).json(present(job));
  } catch (error) {
    if (error instanceof HandoffError) return res.status(error.status).json({ error: error.message });
    console.error('[handoff] не удалось начать перенос:', error);
    return res.status(500).json({ error: 'не удалось начать перенос' });
  }
});

router.get('/:sessionId', (req, res) => {
  const job = getHandoff(String(req.params.sessionId));
  if (!job) return res.status(404).json({ error: 'переноса для этого чата нет' });
  return res.json(present(job));
});

export default router;
