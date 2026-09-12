/**
 * Кто из веб-пользователей запустил работу — и в какой каталог настроек ему
 * при этом можно писать.
 *
 * Раньше этот расчёт жил внутри чат-вебсокета и больше нигде. Встроенный
 * терминал открывался вообще без него: процесс оболочки наследовал окружение
 * сервера целиком, а значит и `CLAUDE_CONFIG_DIR` — то есть общий каталог
 * `~/.claude`, принадлежащий владельцу площадки.
 *
 * 12.09.26 это выстрелило: новый пользователь зашёл по приглашению, открыл
 * терминал, выполнил `/login` — и его вход лёг поверх входа владельца. У
 * владельца в Claude Code сменился аккаунт, а сам новый пользователь при этом
 * на платформе так и числился неподключённым: интерфейс спрашивал про его
 * собственный каталог, где было пусто.
 *
 * Поэтому расчёт теперь один и общий. Правило простое: на площадке с открытой
 * регистрацией у каждого свой каталог, и работа, для которой каталог
 * определить не удалось, не начинается вовсе — молча писать в чужой каталог
 * хуже, чем отказать.
 */

import { credentialsDb, userDb } from '@/modules/database/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { isPlatformOwnerWebUser, OPEN_REGISTRATION } from '@/shared/utils.js';
import { getWebUserClaudeConfigDir } from '@/shared/web-user-paths.js';

const ANTHROPIC_API_KEY_CREDENTIAL_TYPE = 'anthropic_api_key';

export type WebUserRuntimeContext = {
  claudeConfigDir: string | null;
  anthropicApiKey: string | null;
};

/**
 * Достаёт опознанного пользователя из соединения. Форматы разные, потому что
 * их пишут два разных контура входа — платформенный и открытый.
 */
export function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined,
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

/**
 * Каталог настроек и ключ этого пользователя.
 *
 * Возвращает пустые значения, когда открытая регистрация выключена (тогда
 * площадка одноаккаунтная и правильное поведение — наследовать окружение
 * процесса, как было всегда) либо когда пользователь не опознан.
 */
export function resolveWebUserRuntimeContext(
  userId: string | number | null,
): WebUserRuntimeContext {
  if (!OPEN_REGISTRATION || userId === null) {
    return { claudeConfigDir: null, anthropicApiKey: null };
  }

  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId)) {
    return { claudeConfigDir: null, anthropicApiKey: null };
  }

  // Владелец площадки — единственный, у кого два настоящих аккаунта и
  // переключатель между ними. Остальные всегда в своём единственном каталоге.
  const ownerSlot = isPlatformOwnerWebUser(numericUserId)
    ? userDb.getActiveOwnerAccountSlot(numericUserId)
    : undefined;

  return {
    claudeConfigDir: getWebUserClaudeConfigDir(numericUserId, ownerSlot),
    anthropicApiKey: credentialsDb.getActiveCredential(
      numericUserId,
      ANTHROPIC_API_KEY_CREDENTIAL_TYPE,
    ),
  };
}
