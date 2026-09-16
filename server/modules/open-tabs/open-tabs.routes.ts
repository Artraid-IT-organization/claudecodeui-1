/**
 * Открытые вкладки чатов пользователя — общие для телефона и компьютера.
 *
 * GET  /api/open-tabs?since=<версия> — при совпадении версии 204 без тела:
 *      страница спрашивает раз в 15 секунд и при возвращении на неё.
 * PUT  /api/open-tabs { tabs } — записать список целиком, ответ — новое состояние.
 * Устройство см. `database/repositories/open-tabs.ts`.
 */
import express from 'express';

import { openTabsDb } from '@/modules/database/repositories/open-tabs.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

const router = express.Router();

function readUserId(req: express.Request): number | null {
  const id = Number((req as AuthenticatedRequest).user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/', (req, res) => {
  const userId = readUserId(req);
  if (userId === null) return res.status(401).json({ error: 'нет пользователя' });
  try {
    const state = openTabsDb.get(userId);
    const since = Number(req.query.since);
    if (Number.isInteger(since) && since === state.version) return res.status(204).end();
    return res.json({ success: true, ...state });
  } catch (error) {
    console.error('Не удалось прочитать открытые вкладки:', error);
    return res.status(500).json({ error: 'Не удалось прочитать вкладки' });
  }
});

router.put('/', (req, res) => {
  const userId = readUserId(req);
  if (userId === null) return res.status(401).json({ error: 'нет пользователя' });
  try {
    const body = (req.body ?? {}) as { tabs?: unknown };
    if (!Array.isArray(body.tabs)) return res.status(400).json({ error: 'tabs должен быть списком' });
    return res.json({ success: true, ...openTabsDb.put(userId, body.tabs) });
  } catch (error) {
    console.error('Не удалось сохранить открытые вкладки:', error);
    return res.status(500).json({ error: 'Не удалось сохранить вкладки' });
  }
});

export default router;
