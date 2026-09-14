import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';

const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;

// Потребитель — claude-runtime.provider.js: перед `resume` проверить, что
// продолжать есть что; иначе разговор начинается под тем же номером.
/**
 * Есть ли на диске переписка разговора: `<аккаунт>/projects/<папка>/<id>.jsonl`.
 *
 * Нужна перед продолжением разговора: номер в базе появляется раньше файла, и
 * если первый ход оборвался до записи (15.09.26, чат 128968a5 — перезапуск сайта
 * в первые минуты), движок на `resume` отвечает «No conversation found», а каждое
 * следующее сообщение в этом чате пропадает.
 *
 * Когда проверить нельзя (нет папки аккаунта, номер чужого вида, ошибка чтения),
 * отвечает `true` — сомнение трактуется в пользу обычного продолжения.
 */
export async function hasTranscriptOnDisk(
  configDir: string | null | undefined,
  providerSessionId: string | null | undefined,
): Promise<boolean> {
  if (!configDir || !SESSION_ID_RE.test(providerSessionId || '')) {
    return true;
  }
  const projectsRoot = path.join(configDir, 'projects');
  let dirs: Dirent[];
  try {
    dirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    try {
      await fs.access(path.join(projectsRoot, dir.name, `${providerSessionId}.jsonl`));
      return true;
    } catch {
      // В этой папке нет — смотрим следующую.
    }
  }
  return false;
}
