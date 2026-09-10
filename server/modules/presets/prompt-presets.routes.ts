/**
 * HTTP-роуты пресетов промптов.
 *
 * Тонкий слой над `promptPresetsDb`: чтение списка, создание, правка, удаление,
 * смена порядка. Все операции — в рамках текущего пользователя, чтобы пресеты
 * одного не утекли другому.
 */
import express from 'express';

import { promptPresetsDb } from '@/modules/database/index.js';

const router = express.Router();

function readUserId(req: express.Request): number {
  const userId = Number((req as any).user?.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('пользователь не опознан');
  }
  return userId;
}

// Ограничения. Имя короткое — оно уходит в шапку разговора, длинное не влезет.
// Системный промпт — до 32 килобайт: этого хватает даже на подробные инструкции,
// но не даёт ошибочно вставить в пресет весь документ.
const NAME_MAX = 60;
const SYSTEM_PROMPT_MAX = 32 * 1024;

function readName(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('имя пресета не может быть пустым');
  if (raw.length > NAME_MAX) throw new Error(`имя пресета длиннее ${NAME_MAX} символов`);
  return raw;
}

function readSystemPrompt(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  if (raw.length > SYSTEM_PROMPT_MAX) {
    throw new Error(`системный промпт длиннее ${SYSTEM_PROMPT_MAX} символов`);
  }
  return raw;
}

function readOptionalModel(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw || null;
}

router.get('/', (req, res) => {
  try {
    const userId = readUserId(req);
    return res.json({ success: true, presets: promptPresetsDb.list(userId) });
  } catch (error) {
    console.error('Не удалось прочитать список пресетов:', error);
    return res.status(500).json({ error: 'Не удалось прочитать пресеты' });
  }
});

router.post('/', (req, res) => {
  try {
    const userId = readUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const preset = promptPresetsDb.create(userId, {
      name: readName(body.name),
      systemPrompt: readSystemPrompt(body.systemPrompt),
      defaultModel: readOptionalModel(body.defaultModel),
    });
    return res.status(201).json({ success: true, preset });
  } catch (error: any) {
    const message = error?.message || 'не удалось сохранить пресет';
    return res.status(400).json({ error: message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const userId = readUserId(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'некорректный id пресета' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const patch: { name?: string; systemPrompt?: string; defaultModel?: string | null } = {};
    if (body.name !== undefined) patch.name = readName(body.name);
    if (body.systemPrompt !== undefined) patch.systemPrompt = readSystemPrompt(body.systemPrompt);
    if (body.defaultModel !== undefined) patch.defaultModel = readOptionalModel(body.defaultModel);

    const preset = promptPresetsDb.update(userId, id, patch);
    if (!preset) return res.status(404).json({ error: 'пресет не найден' });
    return res.json({ success: true, preset });
  } catch (error: any) {
    const message = error?.message || 'не удалось изменить пресет';
    return res.status(400).json({ error: message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const userId = readUserId(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'некорректный id пресета' });
    }
    const removed = promptPresetsDb.delete(userId, id);
    if (!removed) return res.status(404).json({ error: 'пресет не найден' });
    return res.json({ success: true });
  } catch (error) {
    console.error('Не удалось удалить пресет:', error);
    return res.status(500).json({ error: 'Не удалось удалить пресет' });
  }
});

router.put('/order/all', (req, res) => {
  try {
    const userId = readUserId(req);
    const body = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids)) {
      return res.status(400).json({ error: 'нужен массив ids' });
    }
    const ids = body.ids
      .map((raw) => Number(raw))
      .filter((num) => Number.isInteger(num) && num > 0);
    const presets = promptPresetsDb.reorder(userId, ids);
    return res.json({ success: true, presets });
  } catch (error) {
    console.error('Не удалось изменить порядок пресетов:', error);
    return res.status(500).json({ error: 'Не удалось изменить порядок' });
  }
});

export default router;
