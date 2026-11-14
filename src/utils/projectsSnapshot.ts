import type { Project } from '../types/app';

// Снимок списка папок для мгновенного первого кадра.
//
// Загрузочная заставка «Настройка рабочего пространства» ждёт ответа
// /api/projects, а в окно «заморозки» провайдера (см. doors.js) даже перебор
// двух входов занимает десятки секунд — отсюда «приложение работает через
// раз». Держим последний выданный сервером список в localStorage: страница
// рисуется сразу с ним, свежий список догружается молча и перезаписывает
// снимок. Устаревшие на секунды данные лучше пустого экрана на полминуты.
//
// Ключ привязан к id пользователя из токена: на одном браузере бывают разные
// аккаунты, чужой список показывать нельзя. Без токена снимок не читается и
// не пишется — поведение как раньше (заставка до первого ответа сервера).

const SNAPSHOT_KEY_PREFIX = 'ccui-projects:';

// Id владельца токена из localStorage — ключ снимка. Читаем поле токена
// напрямую, без api.js: модуль должен оставаться лёгким (его тянет инициатор
// состояния при первом рендере) и тестируемым под node без import.meta.env.
const authUserId = (): number | null => {
  try {
    const token = localStorage.getItem('auth-token');
    const parts = token?.split('.') ?? [];
    if (parts.length !== 3) {
      return null;
    }
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { userId?: unknown };
    return typeof payload.userId === 'number' ? payload.userId : null;
  } catch {
    return null;
  }
};

const snapshotKey = (): string | null => {
  const userId = authUserId();
  return userId === null ? null : `${SNAPSHOT_KEY_PREFIX}${userId}`;
};

export const readProjectsSnapshot = (): Project[] | null => {
  const key = snapshotKey();
  if (!key) {
    return null;
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { projects?: unknown } | null;
    return parsed && Array.isArray(parsed.projects) ? (parsed.projects as Project[]) : null;
  } catch {
    return null;
  }
};

export const writeProjectsSnapshot = (projects: Project[]): void => {
  const key = snapshotKey();
  if (!key) {
    return;
  }
  try {
    if (projects.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), projects }));
  } catch {
    // quota/приватный режим — кэш необязателен, приложение живёт и без него.
  }
};
