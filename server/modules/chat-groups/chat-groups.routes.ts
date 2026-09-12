/**
 * HTTP-роуты групп чатов.
 *
 * Всё в рамках аккаунта текущего запроса (`getActiveAccountDir`): группы
 * одного пользователя площадки не видны другому, как и его чаты.
 *
 * После каждой смены группы у чата рассылается `session_upserted` — тот же
 * сигнал, по которому список слева обновляется при новых сообщениях. Без него
 * открытые вкладки узнали бы о новой группе только после перезагрузки.
 */
import express from 'express';

import { chatGroupsDb } from '@/modules/database/repositories/chat-groups.js';
import { sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted } from '@/modules/providers/index.js';
import { getActiveAccountDir } from '@/shared/session-scope.js';

const router = express.Router();

function fail(res: express.Response, status: number, message: string) {
  return res.status(status).json({ error: message });
}

router.get('/', (_req, res) => {
  try {
    return res.json({ success: true, groups: chatGroupsDb.list(getActiveAccountDir()) });
  } catch (error) {
    console.error('Не удалось прочитать группы чатов:', error);
    return fail(res, 500, 'Не удалось прочитать группы');
  }
});

router.post('/', (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const group = chatGroupsDb.create(getActiveAccountDir(), { name: body.name, keywords: body.keywords });
    return res.status(201).json({ success: true, group });
  } catch (error: any) {
    return fail(res, 400, error?.message || 'не удалось создать группу');
  }
});

router.put('/:groupId', (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const group = chatGroupsDb.update(getActiveAccountDir(), String(req.params.groupId), {
      name: body.name,
      keywords: body.keywords,
    });
    if (!group) return fail(res, 404, 'группа не найдена');
    return res.json({ success: true, group });
  } catch (error: any) {
    return fail(res, 400, error?.message || 'не удалось изменить группу');
  }
});

/** Текущая группа и архивность одного чата — шапка спрашивает при открытии. */
router.get('/session/:sessionId', (req, res) => {
  const grouping = chatGroupsDb.getSessionGrouping(getActiveAccountDir(), String(req.params.sessionId));
  if (!grouping) return fail(res, 404, 'чат не найден');
  return res.json({ success: true, ...grouping });
});

/** Ручной выбор группы. `groupId: null` — «без группы». */
router.put('/session/:sessionId', async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId);
    const raw = (req.body ?? {}).groupId;
    const groupId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    if (raw !== null && raw !== undefined && !groupId) {
      return fail(res, 400, 'некорректная группа');
    }

    if (!sessionsDb.getSessionById(sessionId)) return fail(res, 404, 'чат не найден');
    const ok = chatGroupsDb.assignManually(getActiveAccountDir(), sessionId, groupId);
    if (!ok) return fail(res, 404, 'группа или чат не найдены');

    await broadcastSessionUpserted(sessionId);
    return res.json({ success: true, groupId });
  } catch (error) {
    console.error('Не удалось сменить группу чата:', error);
    return fail(res, 500, 'Не удалось сменить группу');
  }
});

/** Разложить по группам все чаты, которые человек не раскладывал сам. */
router.post('/auto-assign', async (_req, res) => {
  try {
    const changed = chatGroupsDb.autoAssignAll(getActiveAccountDir());
    for (const sessionId of changed) {
      await broadcastSessionUpserted(sessionId);
    }
    return res.json({ success: true, changed: changed.length });
  } catch (error) {
    console.error('Не удалось разложить чаты по группам:', error);
    return fail(res, 500, 'Не удалось разложить чаты');
  }
});

export default router;
