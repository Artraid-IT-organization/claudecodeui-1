/**
 * HTTP-роут сохранённых промптов.
 *
 *   GET /api/saved-prompts — список { name, text } из saved-prompts.json
 *
 * Тонкий слой: файл читает сервис, здесь только отдача результата.
 */
import express, { type Request, type Response } from 'express';

import { listSavedPrompts } from './saved-prompts.service.js';

const router = express.Router();

router.get('/', (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, prompts: listSavedPrompts() });
  } catch (error) {
    console.error('Не удалось прочитать сохранённые промпты:', error);
    return res.status(500).json({ error: 'Не удалось прочитать сохранённые промпты' });
  }
});

export default router;
