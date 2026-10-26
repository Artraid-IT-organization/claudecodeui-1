import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  ServerScope,
} from '@/shared/types.js';
import { getRequestRuntimeContext } from '@/shared/request-context.js';
import { getActiveAccountDir } from '@/shared/session-scope.js';
import { ensureJpegForHeic } from '@/shared/image-attachments.js';
import {
  AppError,
  isCodexAllowedForWebUser,
  isPlatformOwnerWebUser,
  normalizeServerScope,
  OPEN_REGISTRATION,
  resolveScopedWorkingDirectory,
} from '@/shared/utils.js';
import { getWebUserWorkspaceRoot } from '@/shared/web-user-paths.js';
import { hasOwnClaudeAccess, resolveWebUserRuntimeContext } from '@/shared/web-user-runtime.js';

import { resolvePinnedProjectBrain } from './project-provider-policy.js';

/**
 * Любой чат читает владелец площадки и человек, которому чат принадлежит
 * (`initiated_by_user_id` или каталог аккаунта — то же правило, что у
 * `assertSessionRowAllowed` в provider.routes). Чужой session id не должен
 * отдавать ни историю, ни provider id, ни метаданные: проверка раньше стояла
 * только на devin, и claude-чаты открывались по прямой ссылке (IDOR, аудит
 * 10.10.26).
 */
const assertSessionReadable = (session: {
  initiated_by_user_id: number | null;
  account_dir: string | null;
}): void => {
  if (!OPEN_REGISTRATION) {
    return;
  }
  const userId = getRequestRuntimeContext()?.userId;
  const numericUserId = userId === undefined || userId === null ? NaN : Number(userId);
  if (Number.isFinite(numericUserId) && isPlatformOwnerWebUser(numericUserId)) {
    return;
  }
  if (session.initiated_by_user_id != null && Number(session.initiated_by_user_id) === numericUserId) {
    return;
  }
  if (session.account_dir != null && session.account_dir === getActiveAccountDir()) {
    return;
  }
  throw new AppError('This session belongs to another user.', {
    code: 'PROVIDER_NOT_ALLOWED',
    statusCode: 403,
  });
};

/**
 * Снимки с телефона лежат в истории вложениями .heic: в ленте они карточкой
 * «File attachment», а картинкой быть не могут — формата нет в списках
 * провайдеров, поэтому на отправке он уезжает в <files_input>. Здесь, в одной
 * точке на всех провайдеров, heic-файлы конвертируются в jpeg и перекладываются
 * в images: лента рисует снимок, как когда он был jpg. Конвертер кладёт jpeg
 * рядом с исходником и помнит его — повторная отдача истории работу не
 * повторяет; неудача оставляет файл карточкой, как раньше.
 */
async function upgradeHeicAttachmentsToImages(messages: NormalizedMessage[]): Promise<void> {
  for (const message of messages) {
    const files = Array.isArray(message.files) ? message.files as Array<Record<string, unknown>> : null;
    if (!files || files.length === 0) {
      continue;
    }

    const remaining: Array<Record<string, unknown>> = [];
    const converted: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const filePath = typeof file?.path === 'string' ? file.path : '';
      const jpegPath = filePath ? await ensureJpegForHeic(filePath) : null;
      if (jpegPath) {
        converted.push({ ...file, path: jpegPath, mimeType: 'image/jpeg' });
      } else {
        remaining.push(file);
      }
    }
    if (converted.length === 0) {
      continue;
    }

    const images = Array.isArray(message.images) ? message.images as Array<Record<string, unknown>> : [];
    message.images = [...images, ...converted];
    message.files = remaining;
  }
}

/**
 * Провайдер, под которым реально пойдёт ход человека общей площадки.
 *
 * У гостя без своего входа в Claude (ни ключа API, ни подписки в его
 * каталоге) `claude` мёртв: браузер мог запомнить его выбор или человек
 * открыл старый чат, и оба пути упирались в «войдите в Claude». Такой чат и
 * такое создание молча переводятся на корпоративный Devin — история при этом
 * остаётся на месте (fetchHistory доклеивает jsonl-стенограмму). Владельца
 * площадки правило не касается: у него вход в Claude свой и живой.
 */
export async function resolveEffectiveProvider(
  provider: LLMProvider,
  userId: string | number | null | undefined,
): Promise<LLMProvider> {
  if (!OPEN_REGISTRATION || provider !== 'claude') {
    return provider;
  }
  const numericUserId = userId === undefined || userId === null ? NaN : Number(userId);
  if (!Number.isFinite(numericUserId) || isPlatformOwnerWebUser(numericUserId)) {
    return provider;
  }
  const runtimeContext = resolveWebUserRuntimeContext(userId ?? null);
  return (await hasOwnClaudeAccess(runtimeContext)) ? 'claude' : 'devin';
}

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  sessionName: string;
};

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
  serverScope: ServerScope;
  flagged: boolean;
  done: boolean;
  promptLaunched: boolean;
};

type RecentSessionListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity' | 'flagged' | 'done'
> & {
  /** Блок верхней панели, в котором виден чат. */
  serverScope: ServerScope;
};

type RecentSessionsPage = {
  conversations: RecentSessionListItem[];
  total: number;
  hasMore: boolean;
};

type SessionDetails = {
  /** Canonical app-facing session id (may differ from the looked-up id when a provider-native id was given). */
  sessionId: string;
  provider: LLMProvider;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isArchived: boolean;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isArchived: boolean;
    serverScope: ServerScope;
  } | null;
};

const MAX_CLOUDCLI_SESSION_NAME_WORDS = 4;
// Independent of the word cap above: `split(/\s+/)` on a message with no
// whitespace at all (a bare URL, a base64/JSON blob, one long unbroken
// token, ...) yields a single-element array, so `.slice(0, 4)` is a no-op
// and the *entire* raw message became the session title — e.g. a full
// pasted link rendering as the session name instead of something readable.
// This caps the result by characters too, regardless of word count.
const MAX_CLOUDCLI_SESSION_NAME_CHARS = 50;

function buildCloudCliSessionName(initialMessage: string): string {
  const words = initialMessage.trim().split(/\s+/).filter(Boolean);
  const name = words.slice(0, MAX_CLOUDCLI_SESSION_NAME_WORDS).join(' ');
  if (!name) {
    return 'Untitled Session';
  }
  if (name.length <= MAX_CLOUDCLI_SESSION_NAME_CHARS) {
    return name;
  }
  return `${name.slice(0, MAX_CLOUDCLI_SESSION_NAME_CHARS).trimEnd()}…`;
}

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  listRunningSessions(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return chatRunRegistry.listRunningRuns();
  },

  /**
   * Returns the active conversation feed in true global activity order.
   */
  listRecentSessions(
    limit: number,
    offset: number,
    serverScope?: ServerScope,
    providerSpace?: 'codex' | 'devin' | 'claude',
    includeInternal = false,
  ): RecentSessionsPage {
    const requestContext = getRequestRuntimeContext();
    const canUseCodex = requestContext === undefined
      || isCodexAllowedForWebUser(requestContext.userId);
    if (providerSpace === 'codex' && !canUseCodex) {
      // У гостя нет хостового входа Codex, а Devin — корпоративный помощник
      // для всех: свои Devin-чаты гость получает отбором initiated_by_user_id
      // внутри hide-codex (sessions.db.ts), пустоту отдавать нельзя.
      return { conversations: [], total: 0, hasMore: false };
    }
    const accountVisibility = canUseCodex ? 'shared-codex' : 'hide-codex';
    const page = sessionsDb.getRecentSessionsPage(
      limit,
      offset,
      serverScope,
      providerSpace,
      accountVisibility,
      includeInternal,
    );
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const conversations = page.sessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        flagged: Boolean(session.is_flagged),
        done: Boolean(session.is_done),
        promptLaunched: Boolean(session.prompt_launched),
        // Блок верхней панели: своё значение чата важнее значения папки.
        serverScope: normalizeServerScope(session.server_scope ?? project?.server_scope),
      };
    });

    return {
      conversations,
      total: page.total,
      hasMore: offset + conversations.length < page.total,
    };
  },

  /**
   * Resolves the provider-native session id a runtime needs for resume.
   *
   * Callers hand provider runtimes the stable app session id; the provider
   * CLIs/SDKs only understand their own native id, which lives on the session
   * row. Ids without a row are assumed to be provider-native already (direct
   * API callers that reference sessions the watcher has not indexed yet).
   */
  resolveProviderSessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }

    const session = sessionsDb.getSessionById(sessionId);
    return session ? session.provider_session_id : sessionId;
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run. Its title
   * comes directly from the first visible CloudCLI message and is limited to
   * four whole words before any provider-owned storage exists.
   */
  async createAppSession(
    provider: LLMProvider,
    projectPath: string,
    initialMessage: string,
    userId?: string | number | null,
  ): Promise<CreateAppSessionResult> {
    // Устаревший выбор провайдера в браузере («Claude» без живого входа)
    // заменяется рабочим — строка сразу ложится под тем провайдером, под
    // которым пойдёт первый ход, и чат не переводится посреди отправки.
    const effectiveProvider = await resolveEffectiveProvider(provider, userId);
    // Рабочая зона не-владельца — его ~/.claude-webuser-<id>/workspace:
    // проект вне зоны (устаревший/чужой путь от клиента) не записывается,
    // чат приземляется в корень зоны — зона у человека одна.
    const numericUserId = userId != null ? Number(userId) : NaN;
    const scopeRoot = OPEN_REGISTRATION
      && Number.isFinite(numericUserId)
      && !isPlatformOwnerWebUser(numericUserId)
      ? getWebUserWorkspaceRoot(numericUserId)
      : null;
    const normalizedProjectPath = resolveScopedWorkingDirectory(projectPath, scopeRoot) ?? '';
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    // Привязка проекта (project-provider-policy, Егор 26.10.26): вкладка
    // «Промпты» владельца сама на Claude не запускается — новый чат наследует
    // последнюю использованную в папке пару помощник+модель; истории ещё нет —
    // работает глобальный выбор composer'а (devin). Только для владельца: у
    // остальных пользователей своя зона — scopeRoot !== null означает
    // не-владельца, и его выбор остаётся нетронутым.
    const pinnedBrain = scopeRoot === null
      ? resolvePinnedProjectBrain(
          normalizedProjectPath,
          effectiveProvider,
          sessionsDb.getLatestProjectBrain(normalizedProjectPath),
        )
      : { provider: effectiveProvider, model: null };

    const sessionId = randomUUID();
    const sessionName = buildCloudCliSessionName(initialMessage);
    sessionsDb.createAppSession(sessionId, pinnedBrain.provider, normalizedProjectPath, sessionName);
    if (pinnedBrain.model) {
      sessionsDb.setSessionModel(sessionId, pinnedBrain.model);
    }

    return {
      sessionId,
      provider: pinnedBrain.provider,
      projectPath: normalizedProjectPath,
      sessionName,
    };
  },

  /**
   * Переносит чат в другой блок верхней панели или возвращает его к
   * значению папки.
   *
   * Файл переписки при этом не двигается: перенос — это признак в базе,
   * поэтому чат остаётся тем же самым, его можно продолжить и вернуть
   * обратно одним нажатием.
   */
  setSessionServerScope(sessionId: string, serverScope: ServerScope | null): { serverScope: ServerScope | null } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);

    sessionsDb.setSessionServerScope(sessionId, serverScope);
    return { serverScope };
  },

  /**
   * Вешает, снимает или переключает метку чата ('none' | 'flag' | 'done').
   * Только метка в базе: файл переписки и порядок чатов не меняются.
   */
  setSessionMark(sessionId: string, mark: 'none' | 'flag' | 'done'): { mark: 'none' | 'flag' | 'done' } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);

    sessionsDb.setSessionMark(sessionId, mark);
    return { mark };
  },

  /**
   * Ставит/снимает признак «промпт из этого чата «Промптов» уже ушёл
   * кнопкой «В новый чат». Независима от mark — метка чата не меняется.
   */
  setSessionPromptLaunched(sessionId: string, launched: boolean): { promptLaunched: boolean } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);

    sessionsDb.setSessionPromptLaunched(sessionId, launched);
    return { promptLaunched: launched };
  },

  /**
   * Resolves the provider-native id only for an explicit user copy action.
   * Normal session payloads continue to expose only the stable app id.
   */
  getProviderSessionId(sessionId: string): string {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);

    if (!session.provider_session_id) {
      throw new AppError('This session ID is not available yet.', {
        code: 'PROVIDER_SESSION_ID_NOT_AVAILABLE',
        statusCode: 409,
      });
    }

    return session.provider_session_id;
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);
    // Чат, переведённый с мёртвого Claude на Devin, держит файл старой
    // переписки в jsonl_path — она доклеивается префиксом ленты, иначе после
    // перевода человек увидел бы пустой чат. У родных devin-строк jsonl_path
    // всегда NULL, поэтому признак встречается только на переведённых.
    const hasLegacyTranscript = session.provider !== 'claude' && Boolean(session.jsonl_path);

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history — unless a
    // legacy transcript remains from the provider migration above.
    if (!session.provider_session_id && !hasLegacyTranscript) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const result = session.provider_session_id
      ? await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
          limit: options.limit ?? null,
          offset: options.offset ?? 0,
          projectPath: session.project_path ?? '',
          providerSessionId: session.provider_session_id,
        })
      : { messages: [], total: 0, hasMore: false, offset: 0, limit: null };

    if (!hasLegacyTranscript) {
      return {
        ...result,
        messages: result.messages.map((message) => ({
          ...message,
          sessionId,
        })),
      };
    }

    // Читалка Claude фильтрует строки стенограммы по provider-native id —
    // он же имя файла (`<id>.jsonl`); в строке его уже нет, после перевода
    // туда записан id нового провайдера.
    const legacyProviderSessionId = path.basename(session.jsonl_path as string, '.jsonl');
    const legacy = await providerRegistry.resolveProvider('claude').sessions.fetchHistory(sessionId, {
      limit: null,
      offset: 0,
      projectPath: session.project_path ?? '',
      providerSessionId: legacyProviderSessionId,
    });

    await upgradeHeicAttachmentsToImages(result.messages);

    return {
      ...result,
      messages: [
        ...legacy.messages,
        ...result.messages,
      ].map((message) => ({
        ...message,
        sessionId,
      })),
      total: legacy.total + result.total,
    };
  },

  /**
   * Полная переписка потоком — для выгрузки чата в файл
   * (`GET /sessions/:id/messages/export`, NDJSON). Разрешает сеанс и права так
   * же, как `fetchHistory`, затем отдаёт сообщения по мере чтения источника:
   * у Claude-читалки безлимитный поток по файлу (постраничный путь режет
   * начало стенограмм длиннее 12 МБ, и выгрузка начиналась с середины чата —
   * Егор 17.10.26). Провайдер без потокового чтения отдаётся через
   * `fetchHistory` без предела — у остальных источников потолка нет.
   * Наследие переведённых чатов идёт первым, как в `fetchHistory`.
   */
  async *streamHistory(sessionId: string): AsyncGenerator<NormalizedMessage> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);
    const hasLegacyTranscript = session.provider !== 'claude' && Boolean(session.jsonl_path);

    if (hasLegacyTranscript) {
      const legacyProviderSessionId = path.basename(session.jsonl_path as string, '.jsonl');
      const legacyStream = providerRegistry.resolveProvider('claude').sessions.streamHistory;
      if (legacyStream) {
        for await (const message of legacyStream(sessionId, {
          projectPath: session.project_path ?? '',
          providerSessionId: legacyProviderSessionId,
        })) {
          yield { ...message, sessionId };
        }
      }
    }

    if (!session.provider_session_id) return;

    const provider = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    if (provider.streamHistory) {
      for await (const message of provider.streamHistory(sessionId, {
        projectPath: session.project_path ?? '',
        providerSessionId: session.provider_session_id,
      })) {
        yield { ...message, sessionId };
      }
      return;
    }

    const result = await provider.fetchHistory(sessionId, {
      limit: null,
      offset: 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });
    for (const message of result.messages) {
      yield { ...message, sessionId };
    }
  },

  /**
   * Resolves one session (by app id, falling back to the provider-native id)
   * to its metadata plus the owning project.
   *
   * This backs deep links like `/session/:sessionId`: the frontend's paginated
   * project payloads only carry each project's first session page, so a
   * session opened directly by URL may not be present client-side at all —
   * this lookup is the authoritative way to learn which project owns it.
   */
  getSessionDetailsById(sessionId: string): SessionDetails {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

    return {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      summary: session.custom_name?.trim() || '',
      createdAt: session.created_at ?? null,
      updatedAt: session.updated_at ?? null,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      isArchived: Boolean(session.isArchived),
      project: project && projectPath
        ? {
            projectId: project.project_id,
            path: projectPath,
            fullPath: projectPath,
            displayName: resolveProjectDisplayName(projectPath, project.custom_project_name),
            isStarred: Boolean(project.isStarred),
            isArchived: Boolean(project.isArchived),
            // Блок папки: без него чат второго сервера, открытый ссылкой,
            // выглядел бы в интерфейсе чатом основного.
            serverScope: normalizeServerScope(project.server_scope),
          }
        : null,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const requestContext = getRequestRuntimeContext();
    const canUseCodex = requestContext === undefined
      || isCodexAllowedForWebUser(requestContext.userId);
    const archivedSessions = sessionsDb.getArchivedSessions(
      canUseCodex ? 'shared-codex' : 'hide-codex',
    );
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
        flagged: Boolean(session.is_flagged),
        done: Boolean(session.is_done),
        promptLaunched: Boolean(session.prompt_launched),
        // Блок верхней панели: архив тоже делится на блоки, иначе дела
        // второго сервера всплывали бы в архиве обычных «Проектов».
        serverScope: normalizeServerScope(session.server_scope ?? project?.server_scope),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionReadable(session);

    sessionsDb.renameSessionByUser(sessionId, summary);
    return { sessionId, summary };
  },
};
