/**
 * Сообщения, отправленные в чат, которого на сервере ещё нет.
 *
 * У существующего чата сообщение уходит в outbox сокета и ждёт расписки
 * сервера. У НОВОГО чата до `chat.send` нужен id сессии, который выдаёт только
 * POST /api/providers/sessions — раньше этот запрос блокировал саму отправку:
 * пока сервер думал (перегруз, плохая сеть), на экране не менялось ничего, а
 * при отказе сообщение просто пропадало из виду.
 *
 * Теперь сообщение ложится сюда (и в localStorage — переживает перезагрузку
 * страницы) в момент нажатия, а доставку делает композер: создаёт сессию с
 * повторами, затем отправляет каждую запись обычным путём через outbox.
 * Несколько сообщений подряд копятся в том же порядке и уходят за первым.
 *
 * Ключ — область черновика (`draftScopeFor`): `project:<projectId>` у нового
 * чата, поэтому записи не перепутываются между чатами.
 */

import type { LLMProvider } from '../../../types/app';

import { safeLocalStorage, type QueuedSendOptions } from './chatStorage';

export type PendingSessionSend = {
  /** Клиентский номер — outbox повторы узнаёт по нему, поэтому он же идёт в chat.send. */
  id: string;
  content: string;
  /** Уже загруженные описания вложений (File-объекты перезагрузку не переживают). */
  attachments: unknown[];
  options: QueuedSendOptions;
  provider: LLMProvider;
  projectPath: string;
  summary: string | null;
  /** Проставляется, когда сессия создана, но записи ещё не все ушли. */
  sessionId: string | null;
  createdAt: number;
};

const keyFor = (scope: string) => `pending_session_sends_${scope}`;

export function listPendingSends(scope: string | null): PendingSessionSend[] {
  if (!scope) return [];
  try {
    const raw = safeLocalStorage.getItem(keyFor(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PendingSessionSend =>
        item && typeof item === 'object' && typeof item.id === 'string',
    );
  } catch {
    return [];
  }
}

function writePendingSends(scope: string, records: PendingSessionSend[]): void {
  try {
    if (records.length === 0) {
      safeLocalStorage.removeItem(keyFor(scope));
    } else {
      safeLocalStorage.setItem(keyFor(scope), JSON.stringify(records));
    }
  } catch {
    // localStorage полон или недоступен — запись потеряется, сообщение
    // останется пузырём в ленте до перезагрузки; дальше скажет об отказе
    // сторож доставки.
  }
}

export function appendPendingSend(scope: string, record: PendingSessionSend): void {
  writePendingSends(scope, [...listPendingSends(scope), record]);
}

export function removePendingSend(scope: string, id: string): void {
  writePendingSends(
    scope,
    listPendingSends(scope).filter((record) => record.id !== id),
  );
}

/** Сессия создана — проставить её номер записям, у которых его ещё нет.
 *  Записи с уже известным sessionId (соседняя партия той же области) не
 *  трогаем — у них свой чат. */
export function stampPendingSession(scope: string, sessionId: string): void {
  writePendingSends(
    scope,
    listPendingSends(scope).map((record) =>
      record.sessionId ? record : { ...record, sessionId },
    ),
  );
}

export function clearPendingSends(scope: string): void {
  try {
    safeLocalStorage.removeItem(keyFor(scope));
  } catch {
    // см. writePendingSends
  }
}
