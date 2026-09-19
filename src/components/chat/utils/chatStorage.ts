import type { ClaudeSettings } from '../types/types';

export const CLAUDE_SETTINGS_KEY = 'claude-settings';

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith('draft_input_') || k.startsWith('queued_message_'));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

/**
 * Composer options captured when a message is queued, so the message can be
 * sent later with the exact settings (model, permission mode, tools) the
 * session's composer had at queue time — even from outside the composer,
 * e.g. the app-level auto-send that fires while another session is viewed.
 */
export type QueuedSendOptions = Record<string, unknown>;

export type StoredQueuedMessage = {
  /** Устойчивый ключ строки очереди: нужен, чтобы двигать и править конкретное сообщение. */
  id?: string;
  content: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
};

export const queuedMessageKey = (sessionId: string) => `queued_message_${sessionId}`;

/**
 * Reads a session's queued message. Understands both the JSON
 * `{ content, options }` format and the legacy raw-text format.
 */
export function readQueuedMessage(sessionId: string): StoredQueuedMessage | null {
  const raw = safeLocalStorage.getItem(queuedMessageKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as StoredQueuedMessage).content === 'string') {
      const { content, options, images, attachments } = parsed as StoredQueuedMessage;
      const normalizedAttachments = Array.isArray(attachments)
        ? attachments
        : Array.isArray(images)
          ? images
          : [];
      return content.trim() || normalizedAttachments.length > 0
        ? { content, options, attachments: normalizedAttachments }
        : null;
    }
  } catch {
    // Legacy format: the raw draft text itself.
  }

  return raw.trim() ? { content: raw } : null;
}

export function writeQueuedMessage(sessionId: string, message: StoredQueuedMessage): void {
  safeLocalStorage.setItem(queuedMessageKey(sessionId), JSON.stringify(message));
}

export function clearQueuedMessage(sessionId: string): void {
  safeLocalStorage.removeItem(queuedMessageKey(sessionId));
}

/**
 * Очередь из нескольких сообщений лежит под ОТДЕЛЬНЫМ ключом, а не дописывается
 * в старый `queued_message_<id>`. Причина не в красоте: старый читатель, увидев
 * массив, не узнаёт ни объект, ни «сырой текст» — и отправляет в чат JSON
 * строкой. Ровно это случилось бы при откате выкатки назад. Отдельный ключ
 * делает откат безобидным: прежняя сборка просто не увидит очередь.
 */
export const queuedMessagesKey = (sessionId: string) => `queued_messages_${sessionId}`;

const newQueuedId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Небезопасный контекст (http://) — randomUUID недоступен.
  }
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const normalizeQueuedMessage = (value: unknown): StoredQueuedMessage | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { id, content, options, images, attachments } = value as StoredQueuedMessage;
  if (typeof content !== 'string') {
    return null;
  }
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments
    : Array.isArray(images)
      ? images
      : [];
  if (!content.trim() && normalizedAttachments.length === 0) {
    return null;
  }
  return {
    id: typeof id === 'string' && id ? id : newQueuedId(),
    content,
    options,
    attachments: normalizedAttachments,
  };
};

/**
 * Читает очередь чата. Понимает новый массив и обе старые формы одного
 * сообщения; старое переносится в новый ключ при первом чтении, поэтому
 * сообщение, поставленное в очередь до обновления страницы, не теряется.
 */
export function readQueuedMessages(sessionId: string): StoredQueuedMessage[] {
  const raw = safeLocalStorage.getItem(queuedMessagesKey(sessionId));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map(normalizeQueuedMessage)
          .filter((item): item is StoredQueuedMessage => item !== null);
      }
    } catch {
      // Битая запись — ниже пробуем старый ключ.
    }
  }

  const legacy = normalizeQueuedMessage(readQueuedMessage(sessionId));
  if (!legacy) {
    clearQueuedMessage(sessionId);
    return [];
  }
  writeQueuedMessages(sessionId, [legacy]);
  clearQueuedMessage(sessionId);
  return [legacy];
}

export function writeQueuedMessages(sessionId: string, messages: StoredQueuedMessage[]): void {
  const cleaned = messages
    .map(normalizeQueuedMessage)
    .filter((item): item is StoredQueuedMessage => item !== null);
  if (cleaned.length === 0) {
    clearQueuedMessages(sessionId);
    return;
  }
  safeLocalStorage.setItem(queuedMessagesKey(sessionId), JSON.stringify(cleaned));
}

export function clearQueuedMessages(sessionId: string): void {
  safeLocalStorage.removeItem(queuedMessagesKey(sessionId));
  clearQueuedMessage(sessionId);
}

export function appendQueuedMessage(
  sessionId: string,
  message: StoredQueuedMessage,
): StoredQueuedMessage[] {
  const next = [...readQueuedMessages(sessionId), { ...message, id: message.id || newQueuedId() }];
  writeQueuedMessages(sessionId, next);
  return next;
}

/**
 * Снимает с очереди первое сообщение и тут же записывает остаток. Это «талон»:
 * кто снял, тот и отправляет — так составитель сообщения и общеприложенческая
 * автоотправка не посылают одно и то же дважды.
 */
export function shiftQueuedMessage(sessionId: string): StoredQueuedMessage | null {
  const all = readQueuedMessages(sessionId);
  if (all.length === 0) {
    return null;
  }
  const [head, ...rest] = all;
  writeQueuedMessages(sessionId, rest);
  return head;
}

/**
 * Черновик в поле ввода принадлежит ЧАТУ, а не проекту.
 *
 * Раньше ключ был `draft_input_<projectId>`, и черновик подтягивался заново
 * только при смене проекта. Почти все чаты Егора живут в одном проекте, поэтому
 * текст, набранный в одном чате, ехал за ним в любой другой. Егор 13.09.26:
 * «если я пишу для одного чата, то переключаясь на другой, панель должна быть
 * без текста, а если возвращаюсь обратно — старый текст остаётся».
 *
 * Область черновика — id чата. У нового чата id появляется только при первой
 * отправке, поэтому до неё черновик живёт в области `project:<projectId>` —
 * то же правило, что выбрали авторы основного проекта для серверных черновиков.
 * Префикс ключа прежний, чтобы очистка переполненного хранилища его находила.
 */
export function draftScopeFor(projectId: string | null | undefined, sessionId: string | null | undefined): string | null {
  if (sessionId) return sessionId;
  if (projectId) return `project:${projectId}`;
  return null;
}

export const draftInputKey = (scope: string) => `draft_input_${scope}`;

export function readDraftInput(scope: string | null): string {
  if (!scope) return '';
  return safeLocalStorage.getItem(draftInputKey(scope)) || '';
}

export function writeDraftInput(scope: string | null, text: string): void {
  if (!scope) return;
  if (text) {
    safeLocalStorage.setItem(draftInputKey(scope), text);
  } else {
    safeLocalStorage.removeItem(draftInputKey(scope));
  }
}

export function clearDraftInput(scope: string | null): void {
  if (!scope) return;
  safeLocalStorage.removeItem(draftInputKey(scope));
}

/**
 * Один раз переносит черновик старого вида (по проекту) в открытый чат.
 *
 * Текст, который человек видел в поле до обновления, остаётся там, где он его
 * видел, и не всплывает потом в случайном чате того же проекта. Свой черновик
 * чата не перетирается. Старый ключ после переноса убирается — иначе он
 * подтянулся бы ещё раз в следующий чат.
 */
export function adoptLegacyProjectDraft(projectId: string | null | undefined, scope: string | null): void {
  if (!projectId || !scope) return;
  const legacyKey = `draft_input_${projectId}`;
  if (legacyKey === draftInputKey(scope)) return;
  const legacy = safeLocalStorage.getItem(legacyKey);
  if (legacy === null) return;
  if (legacy && !readDraftInput(scope)) {
    writeDraftInput(scope, legacy);
  }
  safeLocalStorage.removeItem(legacyKey);
}

export function getClaudeSettings(): ClaudeSettings {
  const raw = safeLocalStorage.getItem(CLAUDE_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      skipPermissions: Boolean(parsed.skipPermissions),
      projectSortOrder: parsed.projectSortOrder || 'name',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }
}
