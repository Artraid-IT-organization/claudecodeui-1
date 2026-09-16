import { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { useAuth } from '../components/auth/context/AuthContext';
import type { Project, ProjectSession } from '../types/app';
import { getSessionTitle } from '../utils/pageTitle';

/**
 * A session the user has explicitly opened, rendered as a tab above the chat
 * area (mirrors the open-editor-tabs strip in VS Code's Claude Code
 * extension). Only sessions the user actually navigated to end up here —
 * never the full sidebar list.
 */
export type OpenSessionTab = {
  sessionId: string;
  projectId?: string;
  provider?: string;
  title: string;
};

type StoredTab = {
  sessionId: string;
  projectId?: string;
  provider?: string;
  title?: string;
};

/**
 * Вкладки хранятся у КАЖДОГО пользователя отдельно.
 *
 * Ключ был один на весь браузер. 12.09.26 Егор открыл ссылку второго
 * пользователя в своём браузере — и над пустым списком чужого рабочего стола
 * висели его собственные вкладки с названиями его разговоров. Сервер здесь ни
 * при чём: это остаток его входа в том же браузере, но выглядит как утечка и
 * по сути ею является — названия чужих чатов видны тому, кто вошёл не под
 * собой.
 *
 * Имя пользователя в ключе разводит их полностью: в одном браузере можно
 * держать два входа, и вкладки не перемешаются.
 */
const STORAGE_KEY_PREFIX = 'open-session-tabs';

const storageKeyFor = (userKey: string | null): string =>
  userKey ? `${STORAGE_KEY_PREFIX}:${userKey}` : STORAGE_KEY_PREFIX;

const readStoredTabs = (userKey: string | null): StoredTab[] => {
  try {
    const raw = localStorage.getItem(storageKeyFor(userKey));
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is StoredTab =>
        Boolean(entry) && typeof (entry as StoredTab).sessionId === 'string' && (entry as StoredTab).sessionId.trim().length > 0)
      .map((entry) => ({
        sessionId: entry.sessionId,
        projectId: typeof entry.projectId === 'string' ? entry.projectId : undefined,
        provider: typeof entry.provider === 'string' ? entry.provider : undefined,
        title: typeof entry.title === 'string' ? entry.title : undefined,
      }));
  } catch {
    return [];
  }
};

const writeStoredTabs = (userKey: string | null, tabs: StoredTab[]) => {
  try {
    localStorage.setItem(storageKeyFor(userKey), JSON.stringify(tabs));
  } catch {
    // Storage unavailable/full: tabs simply won't survive a reload.
  }
};

const findSessionInProjects = (
  projects: Project[],
  sessionId: string,
): { session: ProjectSession; project: Project } | null => {
  for (const project of projects) {
    const session = project.sessions?.find((candidate) => candidate.id === sessionId);
    if (session) {
      return { session, project };
    }
  }
  return null;
};

type UseOpenSessionTabsArgs = {
  /** Full project/session tree from `useProjectsState`, used to keep tab titles live. */
  projects: Project[];
  /** The session currently being viewed (`selectedSession?.id ?? sessionId` upstream). */
  activeSessionId: string | null;
  /** Resolved session object for `activeSessionId`, when available (may lag by a tick). */
  activeSession: ProjectSession | null;
  navigate: NavigateFunction;
};

export function useOpenSessionTabs({ projects, activeSessionId, activeSession, navigate }: UseOpenSessionTabsArgs) {
  const { user } = useAuth();
  const userKey = user?.id != null ? String(user.id) : (user?.username ?? null);

  const [tabs, setTabs] = useState<StoredTab[]>(() => readStoredTabs(userKey));
  const hasHydratedRef = useRef(false);
  const loadedUserKeyRef = useRef(userKey);

  // Сменился пользователь — берём ЕГО вкладки, а не оставляем прежние.
  // Иначе после входа по чужой ссылке над пустым рабочим столом висели бы
  // названия разговоров того, кто сидел в этом браузере до тебя.
  useEffect(() => {
    if (loadedUserKeyRef.current === userKey) return;
    loadedUserKeyRef.current = userKey;
    hasHydratedRef.current = false;
    setTabs(readStoredTabs(userKey));
  }, [userKey]);

  // Skip the very first write so a freshly-read (and therefore identical)
  // value doesn't cause a pointless localStorage write on mount.
  useEffect(() => {
    if (!hasHydratedRef.current) {
      hasHydratedRef.current = true;
      return;
    }
    writeStoredTabs(userKey, tabs);
  }, [tabs, userKey]);

  // Whatever session is currently being viewed always gets a tab — this is
  // the single funnel that covers sidebar clicks, archived-session opens,
  // search results, notifications and deep links alike, without ever having
  // to enumerate every place session navigation can be triggered from.
  useEffect(() => {
    if (!activeSessionId) return;

    setTabs((previous) => {
      const existingIndex = previous.findIndex((tab) => tab.sessionId === activeSessionId);
      const liveMatch = findSessionInProjects(projects, activeSessionId);
      const activeMatchesSession = activeSession?.id === activeSessionId ? activeSession : null;

      const resolvedTitle = liveMatch
        ? getSessionTitle(liveMatch.session)
        : activeMatchesSession
          ? getSessionTitle(activeMatchesSession)
          : undefined;
      const resolvedProjectId = liveMatch?.project.projectId ?? activeMatchesSession?.__projectId;
      const resolvedProvider = liveMatch?.session.__provider ?? activeMatchesSession?.__provider;

      if (existingIndex === -1) {
        return [
          ...previous,
          {
            sessionId: activeSessionId,
            projectId: resolvedProjectId,
            provider: resolvedProvider,
            title: resolvedTitle,
          },
        ];
      }

      const existing = previous[existingIndex];
      const needsUpdate =
        (resolvedTitle !== undefined && resolvedTitle !== existing.title) ||
        (resolvedProjectId !== undefined && resolvedProjectId !== existing.projectId) ||
        (resolvedProvider !== undefined && resolvedProvider !== existing.provider);
      if (!needsUpdate) {
        return previous;
      }

      const next = [...previous];
      next[existingIndex] = {
        ...existing,
        title: resolvedTitle ?? existing.title,
        projectId: resolvedProjectId ?? existing.projectId,
        provider: resolvedProvider ?? existing.provider,
      };
      return next;
    });
  }, [activeSessionId, activeSession, projects]);

  // Keep titles fresh for background tabs too (renames, AI-generated titles
  // filling in after the fact, etc.) as sidebar data streams in.
  useEffect(() => {
    if (projects.length === 0) return;

    setTabs((previous) => {
      let changed = false;
      const next = previous.map((tab) => {
        const liveMatch = findSessionInProjects(projects, tab.sessionId);
        if (!liveMatch) return tab;

        const liveTitle = getSessionTitle(liveMatch.session);
        if (liveTitle === tab.title && liveMatch.project.projectId === tab.projectId) {
          return tab;
        }

        changed = true;
        return { ...tab, title: liveTitle, projectId: liveMatch.project.projectId };
      });
      return changed ? next : previous;
    });
  }, [projects]);

  const switchToTab = useCallback((sessionId: string) => {
    if (sessionId === activeSessionId) return;
    navigate(`/session/${sessionId}`);
  }, [activeSessionId, navigate]);

  const closeTab = useCallback((sessionId: string) => {
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.sessionId === sessionId);
      if (index === -1) return previous;

      const next = previous.filter((tab) => tab.sessionId !== sessionId);

      if (activeSessionId === sessionId) {
        // Prefer the neighboring tab to the right, then the one to the left,
        // then fall back to the empty/new-session view — never a blank crash.
        const neighbor = previous[index + 1] ?? previous[index - 1] ?? null;
        if (neighbor) {
          navigate(`/session/${neighbor.sessionId}`);
        } else {
          navigate('/');
        }
      }

      return next;
    });
  }, [activeSessionId, navigate]);

  // Перетаскивание вкладки: порядок сохраняется в том же localStorage.
  const moveTab = useCallback((sessionId: string, toIndex: number) => {
    setTabs((previous) => {
      const from = previous.findIndex((tab) => tab.sessionId === sessionId);
      if (from === -1) return previous;
      const target = Math.max(0, Math.min(previous.length - 1, toIndex));
      if (from === target) return previous;
      const next = [...previous];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const removeTabsForSessions = useCallback((sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    const idsToRemove = new Set(sessionIds);
    setTabs((previous) => previous.filter((tab) => !idsToRemove.has(tab.sessionId)));
  }, []);

  const openTabs: OpenSessionTab[] = tabs.map((tab) => ({
    sessionId: tab.sessionId,
    projectId: tab.projectId,
    provider: tab.provider,
    title: tab.title?.trim() || 'New Session',
  }));

  return { openTabs, switchToTab, closeTab, moveTab, removeTabsForSessions };
}
