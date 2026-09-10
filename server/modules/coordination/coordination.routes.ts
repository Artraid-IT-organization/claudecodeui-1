/**
 * Роут доски объявлений: что сейчас занято в проекте.
 *
 * Нужен интерфейсу, чтобы показать человеку «этот файл правит такой-то чат»
 * вместо тишины. Только чтение — брать и снимать брони может лишь сам агент
 * через свои хуки.
 */
import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { fileReservations } from '@/modules/coordination/file-reservations.service.js';

const router = express.Router();

router.get('/active', (req, res) => {
  try {
    const raw = typeof req.query.projectPath === 'string' ? req.query.projectPath.trim() : '';
    if (!raw) return res.status(400).json({ error: 'не указан проект' });

    const known = projectsDb.getProjectPath(raw);
    if (!known) return res.status(400).json({ error: 'этот проект не зарегистрирован' });

    const reservations = fileReservations.active(known.project_path);
    return res.json({ success: true, reservations });
  } catch (error) {
    console.error('Не удалось прочитать занятые файлы:', error);
    return res.status(500).json({ error: 'Не удалось прочитать занятые файлы' });
  }
});

export default router;
