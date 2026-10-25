import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';

import { cc2BornProjectDirName, isCc2BornProjectDir } from '@/shared/utils.js';

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

/**
 * Имя каталога `projects/`, в который писать стенограмму этого хода.
 *
 * Чаты закреплённой вкладки («Промпты»), рождённые на общем инстансе (cc2),
 * получают каталог с меткой `--cc2`: синхронизатор основного Claude (cc1)
 * такие каталоги пропускает, и чат не появляется в его списке ни на секунду
 * (Егор 25.10.26: «эти чаты не отображаются у основного Claude»).
 *
 * Продолжение пишет туда, где файл уже лежит: чаты, рождённые до пометки,
 * остаются в обычном каталоге; новые — в помеченном.
 */
export async function resolveBornTranscriptDirName(
  configDir: string,
  cwd: string,
  providerSessionId: string | null | undefined,
): Promise<string> {
  if (SESSION_ID_RE.test(providerSessionId || '')) {
    const projectsRoot = path.join(configDir, 'projects');
    try {
      const dirs = await fs.readdir(projectsRoot, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        try {
          await fs.access(path.join(projectsRoot, dir.name, `${providerSessionId}.jsonl`));
          return dir.name;
        } catch {
          // В этой папке нет — смотрим следующую.
        }
      }
    } catch {
      // Нет корня projects — чат свежий, пишем в помеченный каталог.
    }
  }
  return cc2BornProjectDirName(cwd);
}

/** Путь стенограммы лежит в помеченном (`*--cc2`) каталоге `projects/` — в т.ч. вложенные subagents/tool-results. */
export function isCc2BornTranscriptPath(filePath: string, claudeHome: string): boolean {
  const relative = path.relative(path.join(claudeHome, 'projects'), filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  const firstSegment = relative.split(path.sep)[0] ?? '';
  return isCc2BornProjectDir(firstSegment);
}
