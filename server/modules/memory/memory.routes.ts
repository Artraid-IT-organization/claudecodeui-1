/**
 * Роуты памяти проекта: посмотреть, добавить, удалить факт.
 *
 * Путь к проекту проверяется по базе — как и в чекпойнтах, чтобы через роут
 * нельзя было писать заметки к произвольному каталогу на сервере.
 */
import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { projectMemory, MAX_FACT_LENGTH } from '@/modules/memory/project-memory.service.js';

const router = express.Router();

function resolveProjectPath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('не указан проект');
  const known = projectsDb.getProjectPath(raw);
  if (!known) throw new Error('этот проект не зарегистрирован');
  return known.project_path;
}

router.get('/', (req, res) => {
  try {
    const projectPath = resolveProjectPath(req.query.projectPath);
    return res.json({ success: true, facts: projectMemory.list(projectPath) });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'не удалось прочитать память' });
  }
});

router.post('/', (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectPath = resolveProjectPath(body.projectPath);
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'пустой факт' });
    if (text.length > MAX_FACT_LENGTH) {
      return res.status(400).json({ error: `не длиннее ${MAX_FACT_LENGTH} символов` });
    }

    const fact = projectMemory.remember({
      projectPath,
      text,
      source: body.source === 'agent' ? 'agent' : 'human',
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    });
    return res.status(201).json({ success: true, fact });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'не удалось запомнить' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const projectPath = resolveProjectPath(req.query.projectPath);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'некорректный номер факта' });
    }
    const removed = projectMemory.forget(projectPath, id);
    if (!removed) return res.status(404).json({ error: 'факт не найден' });
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'не удалось удалить' });
  }
});

export default router;
