/**
 * HTTP-роуты чекпойнтов: список снимков, предпросмотр отката, сам откат.
 *
 * Путь к проекту приходит от клиента, поэтому он проверяется по базе проектов:
 * снимок можно смотреть и откатывать только для папки, которая действительно
 * зарегистрирована как проект. Иначе через этот роут можно было бы перезаписать
 * любой каталог на сервере.
 */
import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { checkpointService } from '@/modules/checkpoints/checkpoint.service.js';

const router = express.Router();

function readProjectPath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('не указан проект');

  // Гейт: путь обязан совпасть с зарегистрированным проектом. Без этой
  // проверки через роут можно было бы откатить любой каталог на сервере —
  // путь-то приходит от клиента.
  const known = projectsDb.getProjectPath(raw);
  if (!known) throw new Error('этот проект не зарегистрирован');

  return known.project_path;
}

router.get('/', async (req, res) => {
  try {
    const projectPath = readProjectPath(req.query.projectPath);
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;

    const all = await checkpointService.list(projectPath, 100);
    // Если спросили про конкретный разговор — отдаём только его снимки плюс
    // те, что сделаны до начала работы (у них сессии нет).
    const checkpoints = sessionId
      ? all.filter((item) => !item.sessionId || item.sessionId === sessionId)
      : all;

    return res.json({ success: true, checkpoints });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'не удалось прочитать снимки' });
  }
});

router.get('/usage', async (req, res) => {
  try {
    const projectPath = readProjectPath(req.query.projectPath);
    const bytes = await checkpointService.diskUsage(projectPath);
    return res.json({ success: true, bytes });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'не удалось посчитать размер' });
  }
});

/** Что изменится при откате — показываем ДО того, как человек нажмёт. */
router.get('/:id/preview', async (req, res) => {
  try {
    const projectPath = readProjectPath(req.query.projectPath);
    const files = await checkpointService.diffAgainst(projectPath, req.params.id);
    return res.json({ success: true, files });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'не удалось собрать список файлов' });
  }
});

router.post('/:id/restore', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectPath = readProjectPath(body.projectPath);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;

    const result = await checkpointService.restore(projectPath, req.params.id, sessionId);
    return res.json({
      success: true,
      restored: result.restored,
      safetyCheckpoint: result.safetyCheckpoint,
    });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'не удалось вернуть файлы' });
  }
});

export default router;
