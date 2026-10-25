import { getConnection } from '@/modules/database/connection.js';
import { appConfigDb } from '@/modules/database/repositories/app-config.js';
import { getRequestRuntimeContext } from '@/shared/request-context.js';
import { getActiveAccountDir, type SessionOrigin } from '@/shared/session-scope.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import type { ServerScope, SessionTitleSource } from '@/shared/types.js';
import { normalizeProjectPath, pinnedProjectPathSql } from '@/shared/utils.js';

const TITLE_SOURCE_RANK: Record<SessionTitleSource, number> = {
  naive: 0,
  ai: 1,
  custom: 2,
};

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  title_source: SessionTitleSource;
  /** Model this session runs with; NULL until the app records one for it. */
  model: string | null;
  /** Reasoning effort this session runs with; NULL until the app records one. */
  effort: string | null;
  /** Topic group this session was placed in (manual or auto); NULL = ungrouped. */
  group_id: string | null;
  group_label: string | null;
  /**
   * Переопределение сервера у одного чата: NULL — как у папки ('main' по
   * умолчанию), 'second' — чат живёт во втором блоке верхней панели.
   */
  server_scope: ServerScope | null;
  /** Ярлык-флажок на чате: 1 — висит, 0 — нет. */
  is_flagged: number;
  /** Галочка «сделано»: 1 — стоит, 0 — нет. Взаимоисключает флажок. */
  is_done: number;
  /** Промпт из чата «Промптов» уже ушёл кнопкой «В новый чат»: 1 — да. */
  prompt_launched: number;
  /** Каталог аккаунта, которому принадлежит чат (изоляция пользователей). */
  account_dir: string | null;
  /** Кто из веб-пользователей инициировал чат (NULL у наследия и у строк с диска). */
  initiated_by_user_id: number | null;
  /** devin_connections.id — канал, через который идёт devin-чат. */
  devin_connection_id: number | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type RecentSessionsPage = {
  sessions: SessionRow[];
  total: number;
};

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, title_source, model, effort, group_id, group_label, server_scope, is_flagged, is_done, prompt_launched, account_dir, initiated_by_user_id, devin_connection_id, isArchived, created_at, updated_at';

/**
 * Decides whether a freshly-derived title candidate should replace the
 * row's current one, based on provenance tier rather than presence alone.
 *
 * Ties at the 'ai' or 'custom' tier resolve in the candidate's favor: both
 * mean "a real title was just re-read off disk", and the disk copy is the
 * source of truth, so the freshest read wins. A tie at the 'naive' tier (or
 * no existing name at all) also takes the candidate - there is nothing
 * better to protect. Returns `undefined` fields when nothing should change,
 * so callers can `COALESCE` them against the existing column value.
 */
function resolveTitleUpdate(
  existingName: string | null | undefined,
  existingSource: SessionTitleSource | null | undefined,
  candidateName: string | null | undefined,
  candidateSource: SessionTitleSource | undefined,
): { name?: string; source?: SessionTitleSource } {
  if (candidateSource === undefined || !candidateName) {
    return {};
  }

  const hasExistingName = Boolean(existingName && existingName.trim());
  if (!hasExistingName) {
    return { name: candidateName, source: candidateSource };
  }

  const existingRank = existingSource ? TITLE_SOURCE_RANK[existingSource] : -1;
  const candidateRank = TITLE_SOURCE_RANK[candidateSource];

  if (candidateRank < existingRank) {
    return {};
  }
  if (candidateRank === existingRank && candidateRank === TITLE_SOURCE_RANK.naive) {
    // Both naive: keep whichever naive title is already in place instead of
    // re-deriving on every sync pass (matches the pre-tiering behavior).
    return {};
  }

  return { name: candidateName, source: candidateSource };
}

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

/**
 * SQL fragment scoping a session query to the Claude account the current
 * request represents.
 *
 * `account_dir IS NULL` is deliberately let through. A chat started in the web
 * UI gets its row before any transcript exists, and rows that predate this
 * column are only backfilled once their transcript is seen - excluding NULLs
 * would make a brand-new chat vanish from the sidebar the moment it is
 * created. Every row that HAS a transcript carries its account, which is the
 * case that actually caused one account's history to show up under another.
 */
const ACCOUNT_SCOPE_SQL = ' AND (account_dir IS NULL OR account_dir = ?)';

type SessionAccountVisibility = 'current' | 'shared-codex' | 'hide-codex' | 'all';

/**
 * Builds the account boundary used by session-list queries.
 *
 * Claude histories remain tied to the selected Claude account. Codex and
 * Devin are single host-level owner accounts, so owner-facing lists may
 * deliberately include their rows created while either Claude slot was
 * selected. Guests use `hide-codex`, which also excludes legacy unscoped Codex
 * rows and every Devin row.
 */
function accountVisibilitySql(
  visibility: SessionAccountVisibility,
  tableAlias = '',
): string {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const currentAccount = `(${prefix}account_dir IS NULL OR ${prefix}account_dir = ?)`;

  if (visibility === 'all') {
    return '';
  }
  if (visibility === 'shared-codex') {
    return ` AND (${prefix}provider IN ('codex', 'devin') OR ${currentAccount})`;
  }
  if (visibility === 'hide-codex') {
    // Гость видит свои же чаты Codex/Devin: через корпоративный слой Devin —
    // помощник по умолчанию для всех, и гостевые чаты идут через него
    // (initiated_by_user_id проставляется при создании). Прячутся только
    // чужие строки хостовых входов — то же правило «свой чат» у
    // assertSessionRowAllowed: initiated_by_user_id = я.
    const initiatedBy = Number(getRequestRuntimeContext()?.userId);
    const ownInitiated = Number.isFinite(initiatedBy)
      ? ` OR ${prefix}initiated_by_user_id = ${initiatedBy}`
      : '';
    return ` AND (${prefix}provider NOT IN ('codex', 'devin')${ownInitiated}) AND ${currentAccount}`;
  }
  return ` AND ${currentAccount}`;
}

/**
 * Срез списка чатов под открытый вид панели: помощник (Codex, Devin или все
 * остальные) и блок верхней панели. Тот же отбор, что у ленты последних
 * чатов (`getRecentSessionsPage`), — иначе «Показать ещё чаты» грузит
 * страницы со всеми помощниками и в отфильтрованном списке почти ничего не
 * добавляется.
 */
export type SessionListScope = {
  providerSpace?: 'codex' | 'devin' | 'claude';
  serverScope?: ServerScope;
};

function sessionListScopeSql(
  scope: SessionListScope | undefined,
  tableAlias = 'sessions',
): { sql: string; params: unknown[] } {
  const prefix = `${tableAlias}.`;
  let sql = '';
  const params: unknown[] = [];

  if (scope?.providerSpace === 'codex' || scope?.providerSpace === 'devin') {
    // Пространство devin у владельца включает и claude-чаты закреплённых
    // проектов («Промпты» — мозги Claude, но видны в базе Devin; Егор 25.10.26).
    const pinnedOr = scope.providerSpace === 'devin' ? ` OR ${pinnedProjectPathSql(prefix.slice(0, -1))}` : '';
    sql += ` AND (${prefix}provider = '${scope.providerSpace}'${pinnedOr})`;
  } else if (scope?.providerSpace === 'claude') {
    sql += ` AND ${prefix}provider NOT IN ('codex', 'devin') AND NOT ${pinnedProjectPathSql(prefix.slice(0, -1))}`;
  }

  if (scope?.serverScope) {
    sql += ` AND COALESCE(${prefix}server_scope, (SELECT projects.server_scope FROM projects WHERE projects.project_path = ${prefix}project_path), 'main') = ?`;
    params.push(scope.serverScope);
  }

  return { sql, params };
}

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row. An
   * app-created row keeps its existing name; synchronizer names only update
   * rows that were themselves created by indexing provider storage.
   */
  /**
   * `titleSource` is opt-in: callers that know how to classify their
   * candidate title (the Claude synchronizer from transcript title events,
   * the Devin synchronizer from the CLI's generated `sessions.title`) pass
   * it and get the tiered naive/ai/custom comparison from
   * `resolveTitleUpdate()`. Callers that omit it (cursor/codex/opencode
   * synchronizers) keep the original "freeze once any custom_name exists"
   * behavior unchanged, so this fix stays scoped to the provider it was
   * reported for.
   */
  /*
   * `project_path` у рождённой в вебе строки (`origin='web'`) провайдер не
   * перетирает: человек выбрал проект при создании, а cwd, который присылает
   * синхронизатор, может быть другим написанием того же места (Devin пишет в
   * sessions.db realpath — у гостей team-access `workspace/work` это симлинк,
   * и чат уезжал в одноимённую папку-двойник: «не все чаты в списке»).
   * Строкам без веб-выбора (terminal/auto/CLI) cwd провайдера — правда.
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null,
    titleSource?: SessionTitleSource,
    scope?: { accountDir?: string | null; origin?: SessionOrigin | null }
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    const existing = db
      .prepare(
        `SELECT session_id, custom_name, title_source FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as
      | { session_id: string; custom_name: string | null; title_source: SessionTitleSource }
      | undefined;

    if (existing) {
      if (titleSource !== undefined) {
        const resolved = resolveTitleUpdate(existing.custom_name, existing.title_source, customName, titleSource);
        db.prepare(
          `UPDATE sessions SET
             provider = ?,
             updated_at = COALESCE(?, CURRENT_TIMESTAMP),
             project_path = CASE
               WHEN origin = 'web' AND project_path IS NOT NULL THEN project_path
               ELSE ?
             END,
             jsonl_path = ?,
             account_dir = COALESCE(?, account_dir),
             origin = COALESCE(origin, ?),
             custom_name = COALESCE(?, custom_name),
             title_source = COALESCE(?, title_source)
           WHERE session_id = ?`
        ).run(
          provider,
          updatedAtValue,
          normalizedProjectPath,
          jsonlPath ?? null,
          scope?.accountDir ?? null,
          scope?.origin ?? null,
          resolved.name ?? null,
          resolved.source ?? null,
          existing.session_id
        );
      } else {
        db.prepare(
          `UPDATE sessions SET
             provider = ?,
             updated_at = COALESCE(?, CURRENT_TIMESTAMP),
             project_path = CASE
               WHEN origin = 'web' AND project_path IS NOT NULL THEN project_path
               ELSE ?
             END,
             jsonl_path = ?,
             account_dir = COALESCE(?, account_dir),
             origin = COALESCE(origin, ?),
             custom_name = CASE
               WHEN session_id <> provider_session_id AND custom_name IS NOT NULL THEN custom_name
               ELSE COALESCE(?, custom_name)
             END
           WHERE session_id = ?`
        ).run(
          provider,
          updatedAtValue,
          normalizedProjectPath,
          jsonlPath ?? null,
          scope?.accountDir ?? null,
          scope?.origin ?? null,
          customName ?? null,
          existing.session_id
        );
      }

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, title_source, project_path, jsonl_path, account_dir, origin, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = CASE
           WHEN sessions.origin = 'web' AND sessions.project_path IS NOT NULL
             THEN sessions.project_path
           ELSE excluded.project_path
         END,
         jsonl_path = excluded.jsonl_path,
         account_dir = COALESCE(excluded.account_dir, sessions.account_dir),
         origin = COALESCE(sessions.origin, excluded.origin),
         custom_name = CASE
           WHEN sessions.session_id <> sessions.provider_session_id AND sessions.custom_name IS NOT NULL
             THEN sessions.custom_name
           ELSE COALESCE(excluded.custom_name, sessions.custom_name)
         END,
         title_source = COALESCE(excluded.title_source, sessions.title_source)`
    ).run(
      providerSessionId,
      provider,
      providerSessionId,
      customName ?? null,
      titleSource ?? 'naive',
      normalizedProjectPath,
      jsonlPath ?? null,
      scope?.accountDir ?? null,
      scope?.origin ?? null,
      scope?.origin === 'auto' ? 1 : 0,
      createdAtValue,
      updatedAtValue
    );

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping. `customName` is derived
   * from the first visible CloudCLI message by the sessions service.
   */
  createAppSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
  ): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    // Атрибуция: чат создаётся HTTP-роутом внутри request-контекста, поэтому
    // id веб-пользователя доступен здесь без изменения сигнатур выше по стеку.
    const rawUserId = getRequestRuntimeContext()?.userId;
    const initiatedByUserId = rawUserId === null || rawUserId === undefined
      ? null
      : Number(rawUserId);

    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, title_source, project_path, jsonl_path, account_dir, origin, initiated_by_user_id, isArchived, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'naive', ?, NULL, ?, 'web', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(
      sessionId,
      provider,
      customName ?? null,
      normalizedProjectPath,
      getActiveAccountDir(),
      Number.isFinite(initiatedByUserId) ? initiatedByUserId : null,
    );

    return sessionId;
  },

  /**
   * Прибивает devin-чат к корпоративному каналу (devin_connections.id).
   * Ставится рантаймом в момент session/new и при resume: канал чата не
   * меняется — sessions.db живёт внутри каталога канала.
   */
  setSessionDevinConnection(sessionId: string, connectionId: number | null): void {
    getConnection()
      .prepare('UPDATE sessions SET devin_connection_id = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?')
      .run(connectionId, sessionId);
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): void {
    const db = getConnection();

    const merge = db.transaction(() => {
      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             custom_name = COALESCE(custom_name, ?),
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        ).run(providerSessionId, duplicate.jsonl_path, duplicate.custom_name, sessionId);
        return;
      }

      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(providerSessionId, sessionId);
    });

    merge();
  },

  /**
   * Переводит чат на другого провайдера (миграция Claude → Devin у человека
   * без своего доступа к Claude).
   *
   * `provider_session_id` обнуляется намеренно: новый провайдер не умеет
   * продолжать чужую сессию, он начнёт свою и назовёт свой id — его запишет
   * `assignProviderSessionId`. `model`/`effort` сбрасываются тоже — записанная
   * Claude-модель передалась бы новому провайдеру как `--model claude-…` и
   * завалила бы ход. Переписка до перевода не теряется: файл остаётся в
   * `jsonl_path`, и читалка истории доклеивает его к ленте
   * (sessions.service.fetchHistory).
   */
  retargetSessionProvider(sessionId: string, provider: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET provider = ?,
           provider_session_id = NULL,
           model = NULL,
           effort = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ?`
    ).run(provider, sessionId);
  },

  /**
   * Строка чата, которой принадлежит файл переписки.
   *
   * Синхронизатор Claude пропускает стенограмму, занятую переведённым на
   * другого провайдера чатом (`provider <> 'claude'`): иначе обход файлов
   * посеял бы вторую строку того же разговора под старым провайдером, и в
   * списке возникал чат-призрак.
   */
  getSessionByTranscriptPath(jsonlPath: string): Pick<SessionRow, 'session_id' | 'provider'> | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT session_id, provider
         FROM sessions
         WHERE jsonl_path = ?
         LIMIT 1`
      )
      .get(jsonlPath) as Pick<SessionRow, 'session_id' | 'provider'> | undefined;

    return row ?? null;
  },

  /**
   * Records the model one session runs with.
   *
   * Called both when the user picks a model for the session and on every send,
   * so the row always reflects what the session last ran with and reopening it
   * restores that model instead of a catalog default.
   */
  setSessionModel(sessionId: string, model: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET model = ?
       WHERE session_id = ?`
    ).run(model, sessionId);
  },

  /**
   * Records the reasoning effort one session runs with.
   *
   * `default` is stored as an explicit choice rather than NULL so reopening
   * the session does not inherit a later per-provider effort preference.
   */
  setSessionEffort(sessionId: string, effort: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET effort = ?
       WHERE session_id = ?`
    ).run(effort, sessionId);
  },

  /**
   * Запомнить путь к файлу переписки, если он ещё не записан.
   *
   * У чата, начатого с сайта, путь появляется только после периодического
   * обхода файлов — минуты спустя. До этого история отдавалась пустой, и
   * открытая вкладка не видела ответа (живой тест 13.09.26: запрос истории
   * вернул 0 сообщений при готовом ответе в файле). Уже записанный путь не
   * перезаписывается.
   */
  setJsonlPathIfMissing(sessionId: string, jsonlPath: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET jsonl_path = ?
       WHERE session_id = ? AND jsonl_path IS NULL`
    ).run(jsonlPath, sessionId);
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  /**
   * Renames a session on the user's explicit instruction (the web rename
   * action), tagging it 'custom' tier. Deliberately separate from
   * `updateSessionCustomName` - that method is also called by the codex
   * synchronizer for its own auto-derived names, which must NOT be tagged
   * as a manual rename or they would be frozen against future improvement.
   * A 'custom' tier row is the top of `resolveTitleUpdate()`'s ranking, so
   * once this runs, no later sync can silently replace the user's title.
   */
  renameSessionByUser(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?, title_source = 'custom'
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  /**
   * Assigns a topic group (manual or auto) to one session. Passing
   * `groupId: null` clears the session back to ungrouped.
   */
  /**
   * Переносит один чат в блок верхней панели ('main' / 'second') или
   * возвращает его к значению папки (null).
   */
  setSessionServerScope(sessionId: string, serverScope: ServerScope | null): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET server_scope = ?
       WHERE session_id = ?`
    ).run(serverScope, sessionId);
  },

  /**
   * Вешает, снимает или переключает метку чата. `updated_at` не трогаем:
   * метка — не активность, и чат не должен от неё подниматься в списке.
   * Флажок и галочка взаимоисключаются.
   */
  setSessionMark(sessionId: string, mark: 'none' | 'flag' | 'done'): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET is_flagged = ?, is_done = ?
       WHERE session_id = ?`
    ).run(mark === 'flag' ? 1 : 0, mark === 'done' ? 1 : 0, sessionId);
  },

  /**
   * Отмечает/снимает признак «промпт из этого чата «Промптов» уже ушёл
   * кнопкой «В новый чат». `updated_at` не трогаем — метка не активность.
   */
  setSessionPromptLaunched(sessionId: string, launched: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET prompt_launched = ?
       WHERE session_id = ?`
    ).run(launched ? 1 : 0, sessionId);
  },

  setSessionGroup(sessionId: string, groupId: string | null, groupLabel: string | null): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET group_id = ?, group_label = ?
       WHERE session_id = ?`
    ).run(groupId, groupLabel, sessionId);
  },

  /**
   * Applies many group assignments atomically, so the sidebar never
   * observes a project half-regrouped mid-broadcast.
   */
  assignSessionGroups(assignments: Array<{ sessionId: string; groupId: string; groupLabel: string }>): void {
    if (assignments.length === 0) {
      return;
    }

    const db = getConnection();
    const stmt = db.prepare(
      `UPDATE sessions
       SET group_id = ?, group_label = ?
       WHERE session_id = ?`
    );
    const applyAll = db.transaction((rows: typeof assignments) => {
      for (const row of rows) {
        stmt.run(row.groupId, row.groupLabel, row.sessionId);
      }
    });
    applyAll(assignments);
  },

  /**
   * Active (non-archived) sessions for a project that have no topic group
   * yet, newest first - the candidate pool for "Organize by topic". Devin chats are
   * left out: that pass asks Claude, and Devin mode must spend only Devin tokens.
   */
  getUngroupedSessionsByProjectPath(projectPath: string, limit: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND group_id IS NULL
           AND provider <> 'devin'
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ?`
      )
      .all(normalizedProjectPath, limit) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`
      )
      .get(provider, normalizedProjectPath) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Все ожидающие provider-id app-строки провайдера — кандидаты на привязку,
   * когда точного совпадения `project_path` нет. Devin хранит в sessions.db
   * `working_directory` в realpath-написании, а app-строка рождается с
   * лексическим путём (у гостей team-access `workspace/work` — симлинк), так
   * что равенство строк тут не работает: сравнивать по realpath обязан
   * вызывающий. Потребитель — devin-session-synchronizer.
   */
  findPendingAppSessions(provider: string): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all(provider) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Все известные пути транскриптов из таблицы сессий. Инкрементальный скан
   * сверяет с ними диск: файл, которого нет в базе, индексируется независимо
   * от mtime — иначе появившийся с «старым» временем (копия с сохранённым
   * mtime, файл, долившийся между курсором и границей скана) навсегда
   * оставался невидимым. Потребитель — claude-session-synchronizer.
   */
  listTranscriptPaths(): string[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT jsonl_path FROM sessions WHERE jsonl_path IS NOT NULL`)
      .all() as { jsonl_path: string }[];

    return rows.map((row) => row.jsonl_path);
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0` + ACCOUNT_SCOPE_SQL
      )
      .all(getActiveAccountDir()) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Returns one globally ordered page of visible conversations.
   *
   * Pagination happens after archived sessions and sessions belonging to an
   * archived project have been excluded. This keeps the sidebar feed complete
   * and correctly ordered across projects instead of flattening only the
   * per-project slices already loaded by the client.
   */
  getRecentSessionsPage(
    limit: number,
    offset: number,
    serverScope?: ServerScope,
    providerSpace?: 'codex' | 'devin' | 'claude',
    accountVisibility: SessionAccountVisibility = 'current',
    includeInternal = false,
  ): RecentSessionsPage {
    const db = getConnection();
    // Лента отдаётся по одному блоку верхней панели за раз. Отбирать на
    // клиенте нельзя: страница берётся по 40 чатов, и при отборе после
    // выдачи страница второго сервера почти всегда оказывалась бы пустой,
    // а «показать ещё» не находило бы конца.
    const scopeClause = (serverScope
      ? ` AND COALESCE(sessions.server_scope, projects.server_scope, 'main') = ?`
      : '')
      // Чаты Codex — свой список, как второй блок (Егор 29.09.26: «его чат
      // находится среди других чатов — странно и неудобно»).
      + (providerSpace === 'codex' ? ` AND sessions.provider = 'codex'` : '')
      + (providerSpace === 'devin' ? ` AND (sessions.provider = 'devin' OR ${pinnedProjectPathSql('sessions')})` : '')
      + (providerSpace === 'claude' ? ` AND sessions.provider NOT IN ('codex', 'devin') AND NOT ${pinnedProjectPathSql('sessions')}` : '');
    // Лента — только чаты, запущенные человеком (Егор 15.10.26: «запуски
    // нейросетей я не должен видеть, мне важен результат»). Служебные =
    // origin='auto' + одноразовые папки (та же логика, что isMachineMadeChat
    // в chat-groups). includeInternal возвращает служебные одним параметром —
    // маленькая кнопка «показать служебные» внизу списка. Проект «Промпты»
    // всегда остаётся только в своей закреплённой секции (Егор 19.10.26).
    const internalClause = includeInternal ? '' : `
      AND (sessions.origin IS NULL OR sessions.origin <> 'auto')
      AND (sessions.project_path IS NULL OR (
        sessions.project_path NOT LIKE '/tmp/%'
        AND lower(sessions.project_path) NOT GLOB '*e2e[-_]*'
        AND lower(sessions.project_path) NOT GLOB '*e2e'
      ))
    `;
    const promptsClause = `
      AND COALESCE(sessions.project_path, '') <> '/home/claude/prompts'
      AND COALESCE(projects.custom_project_name, '') <> 'Промпты'
    `;
    const visibilityClause = `
      sessions.isArchived = 0
      AND (projects.isArchived IS NULL OR projects.isArchived = 0)
    ` + internalClause + promptsClause + accountVisibilitySql(accountVisibility, 'sessions') + scopeClause;
    const accountDir = getActiveAccountDir();
    const scopeParams = serverScope ? [serverScope] : [];
    const rows = db
      .prepare(
        `SELECT sessions.*
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}
         ORDER BY julianday(COALESCE(sessions.updated_at, sessions.created_at)) DESC,
                  sessions.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(accountDir, ...scopeParams, limit, offset) as SessionRow[];
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}`
      )
      .get(accountDir, ...scopeParams) as { count: number } | undefined;

    return {
      sessions: normalizeSessionRows(rows),
      total: Number(countRow?.count ?? 0),
    };
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(accountVisibility: SessionAccountVisibility = 'current'): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1` + accountVisibilitySql(accountVisibility) + `
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all(getActiveAccountDir()) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0` + ACCOUNT_SCOPE_SQL
      )
      .all(normalizedProjectPath, getActiveAccountDir()) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(
    projectPath: string,
    accountVisibility: SessionAccountVisibility = 'current',
  ): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    // Скоуп обязателен и здесь: путь проекта не уникален между аккаунтами
    // (симлинк/realpath дают один project_path у разных webuser-корней), и без
    // него архивный вид показывал чужие сессии. Permanent project deletion
    // передаёт 'all' явно — оно обязано вычистить транскрипты всех владельцев.
    const visibilitySql = accountVisibility
      ? accountVisibilitySql(accountVisibility)
      : '';
    const visibilityParams = accountVisibility ? [getActiveAccountDir()] : [];
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?${visibilitySql}`
      )
      .all(normalizedProjectPath, ...visibilityParams) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPathPage(
    projectPath: string,
    limit: number,
    offset: number,
    accountVisibility: SessionAccountVisibility = 'current',
    scope?: SessionListScope,
  ): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const scopeSql = sessionListScopeSql(scope);
    // Чаты, перенесённые в другой блок поимённо (`server_scope` задан и не
    // совпадает с блоком папки), идут в первую порцию: панель делит папку по
    // блокам уже у себя, и старый перенесённый чат за пределами первых 20 не
    // был бы виден ни в одном блоке. Совпадающий признак не поднимаем — он
    // занял бы место чужого чата папки. На экране порядок всё равно по дате —
    // список сортирует клиент.
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0` + accountVisibilitySql(accountVisibility) + scopeSql.sql + `
         ORDER BY (
           sessions.server_scope IS NOT NULL
           AND sessions.server_scope <> COALESCE(
             (SELECT projects.server_scope FROM projects WHERE projects.project_path = sessions.project_path),
             'main'
           )
         ) DESC, datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, getActiveAccountDir(), ...scopeSql.params, limit, offset) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Порции чатов сразу для всех папок списка проектов: одна выборка с
   * нумерацией строк внутри каждой папки вместо отдельного запроса на папку.
   * Отбор и порядок — ровно как у getSessionsByProjectPathPage (перенесённые
   * в другой блок чаты первыми, дальше по дате). 14.10.26 список проектов
   * делал ~3 запроса на каждую из ~110 папок — на занятом процессоре это
   * стоило больше секунды на запрос списка.
   */
  getSessionsByProjectPathsPage(
    projectPaths: string[],
    limit: number,
    offset: number,
    accountVisibility: SessionAccountVisibility = 'current',
    scope?: SessionListScope,
  ): Map<string, SessionRow[]> {
    const result = new Map<string, SessionRow[]>();
    if (projectPaths.length === 0) return result;
    const db = getConnection();
    const normalized = projectPaths.map((p) => normalizeProjectPath(p));
    const visibilitySql = accountVisibilitySql(accountVisibility, 's');
    const scopeSql = sessionListScopeSql(scope, 's');
    const params: unknown[] = [...normalized];
    if (visibilitySql.includes('?')) params.push(getActiveAccountDir());
    params.push(...scopeSql.params, offset, offset + limit);
    const columns = SESSION_ROW_COLUMNS.split(', ').map((c) => `s.${c}`).join(', ');
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT ${columns},
             ROW_NUMBER() OVER (
               PARTITION BY s.project_path
               ORDER BY (
                 s.server_scope IS NOT NULL
                 AND s.server_scope <> COALESCE(
                   (SELECT projects.server_scope FROM projects WHERE projects.project_path = s.project_path),
                   'main'
                 )
               ) DESC,
               datetime(COALESCE(s.updated_at, s.created_at)) DESC,
               s.session_id DESC
             ) AS __rn
           FROM sessions s
           WHERE s.project_path IN (${normalized.map(() => '?').join(',')})
             AND s.isArchived = 0` + visibilitySql + scopeSql.sql + `
         )
         WHERE __rn > ? AND __rn <= ?
         ORDER BY project_path, __rn`
      )
      .all(...params) as Array<SessionRow & { __rn: number }>;

    for (const row of rows) {
      const key = normalizeProjectPath(row.project_path ?? '');
      const list = result.get(key) ?? [];
      list.push(row);
      result.set(key, list);
    }
    for (const [key, list] of result) {
      result.set(key, normalizeSessionRows(list));
    }
    return result;
  },

  /**
   * «Сколько чатов» для всех папок одним GROUP BY — пара к
   * getSessionsByProjectPathsPage.
   */
  countSessionsByProjectPaths(
    projectPaths: string[],
    accountVisibility: SessionAccountVisibility = 'current',
    scope?: SessionListScope,
  ): Map<string, number> {
    const result = new Map<string, number>();
    if (projectPaths.length === 0) return result;
    const db = getConnection();
    const normalized = projectPaths.map((p) => normalizeProjectPath(p));
    const visibilitySql = accountVisibilitySql(accountVisibility, 's');
    const scopeSql = sessionListScopeSql(scope, 's');
    const params: unknown[] = [...normalized];
    if (visibilitySql.includes('?')) params.push(getActiveAccountDir());
    params.push(...scopeSql.params);
    const rows = db
      .prepare(
        `SELECT s.project_path AS project_path, COUNT(*) AS count
         FROM sessions s
         WHERE s.project_path IN (${normalized.map(() => '?').join(',')})
           AND s.isArchived = 0` + visibilitySql + scopeSql.sql + `
         GROUP BY s.project_path`
      )
      .all(...params) as Array<{ project_path: string; count: number }>;

    for (const row of rows) {
      result.set(normalizeProjectPath(row.project_path), Number(row.count));
    }
    return result;
  },

  /**
   * Раскладка чатов по помощнику и блоку для всех папок одним запросом —
   * пакетная версия countSessionsByProjectPathGrouped.
   */
  countSessionsByProjectPathsGrouped(
    projectPaths: string[],
    accountVisibility: SessionAccountVisibility = 'current',
  ): Map<string, Array<{ provider: string; serverScope: ServerScope; count: number }>> {
    const result = new Map<string, Array<{ provider: string; serverScope: ServerScope; count: number }>>();
    if (projectPaths.length === 0) return result;
    const db = getConnection();
    const normalized = projectPaths.map((p) => normalizeProjectPath(p));
    const visibilitySql = accountVisibilitySql(accountVisibility, 's');
    const params: unknown[] = [...normalized];
    if (visibilitySql.includes('?')) params.push(getActiveAccountDir());
    const rows = db
      .prepare(
        `SELECT s.project_path AS project_path,
                s.provider AS provider,
                COALESCE(s.server_scope,
                  (SELECT projects.server_scope FROM projects WHERE projects.project_path = s.project_path),
                  'main') AS effective_scope,
                COUNT(*) AS count
         FROM sessions s
         WHERE s.project_path IN (${normalized.map(() => '?').join(',')})
           AND s.isArchived = 0` + visibilitySql + `
         GROUP BY s.project_path, s.provider, effective_scope`
      )
      .all(...params) as Array<{
        project_path: string;
        provider: string;
        effective_scope: ServerScope;
        count: number;
      }>;

    for (const row of rows) {
      const key = normalizeProjectPath(row.project_path);
      const list = result.get(key) ?? [];
      list.push({
        provider: row.provider,
        serverScope: row.effective_scope,
        count: Number(row.count),
      });
      result.set(key, list);
    }
    return result;
  },

  /**
   * Moves this account's script-launched sessions into the archive - once.
   *
   * New `auto` sessions are archived as they are inserted, but rows indexed
   * before that classification existed are already sitting in the active
   * list. This is the one-off catch-up for them.
   *
   * It records that it ran, so a session the user later takes back OUT of the
   * archive is never quietly re-archived behind them.
   */
  archiveAutomatedSessionsOnce(accountDir: string): number {
    const db = getConnection();
    const flagKey = `auto_sessions_tidied:${accountDir}`;
    if (appConfigDb.get(flagKey)) {
      return 0;
    }

    // Guard against acting on a scan that never ran: without at least one
    // classified session there is nothing to judge the rest against.
    //
    // Deliberately NOT "every session is classified". Rows whose transcript
    // has since been deleted can never be classified - 14 such orphans exist
    // on this instance - so that stricter condition is unreachable and would
    // block the catch-up forever.
    const classified = db
      .prepare(
        `SELECT COUNT(*) AS count FROM sessions
         WHERE account_dir = ? AND origin IS NOT NULL`
      )
      .get(accountDir) as { count: number } | undefined;

    if (Number(classified?.count ?? 0) === 0) {
      return 0;
    }

    const result = db
      .prepare(
        `UPDATE sessions SET isArchived = 1
         WHERE account_dir = ? AND origin = 'auto' AND isArchived = 0`
      )
      .run(accountDir);

    appConfigDb.set(flagKey, new Date().toISOString());
    return result.changes;
  },

  /**
   * Moves indexed Devin sessions that never had an app row into the archive
   * - once.
   *
   * Before 07.10.26 the Devin synchronizer stamped every session it found on
   * disk as origin 'terminal' and left it in the active list, so one-shot
   * probes and model loans (`devin -p`, external ACP runs) piled up in the
   * regular sidebar. Foreign sessions now arrive as 'auto' and archive on
   * insert; this is the one-off catch-up for the rows indexed before that.
   *
   * Discriminator: an app-owned chat's row keeps its own UUID `session_id`
   * with the Devin slug in `provider_session_id`; a row indexed straight
   * off disk repeats the slug in both columns. The origin is flipped to
   * 'auto' too - 'terminal' was a placeholder that claimed these runs were
   * typed by a person.
   *
   * Records that it ran, so a session the user later takes back OUT of the
   * archive is never quietly re-archived behind them.
   */
  archiveForeignDevinSessionsOnce(accountDir: string): number {
    const db = getConnection();
    const flagKey = `devin_foreign_sessions_tidied:${accountDir}`;
    if (appConfigDb.get(flagKey)) {
      return 0;
    }

    const result = db
      .prepare(
        `UPDATE sessions SET isArchived = 1, origin = 'auto'
         WHERE account_dir = ? AND provider = 'devin'
           AND provider_session_id IS NOT NULL
           AND session_id = provider_session_id`
      )
      .run(accountDir);

    appConfigDb.set(flagKey, new Date().toISOString());
    return result.changes;
  },

  countSessionsByProjectPath(
    projectPath: string,
    accountVisibility: SessionAccountVisibility = 'current',
    scope?: SessionListScope,
  ): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const scopeSql = sessionListScopeSql(scope);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0` + accountVisibilitySql(accountVisibility) + scopeSql.sql
      )
      .get(normalizedProjectPath, getActiveAccountDir(), ...scopeSql.params) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  /**
   * Раскладка чатов папки по помощнику и блоку верхней панели — «сколько
   * всего» в каждом из срезов, по которым панель делит список. Нужна, чтобы
   * «Показать ещё чаты» знало конец списка внутри своего среза, а не всех
   * помощников сразу.
   */
  countSessionsByProjectPathGrouped(
    projectPath: string,
    accountVisibility: SessionAccountVisibility = 'current',
  ): Array<{ provider: string; serverScope: ServerScope; count: number }> {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT sessions.provider AS provider,
                COALESCE(sessions.server_scope,
                  (SELECT projects.server_scope FROM projects WHERE projects.project_path = sessions.project_path),
                  'main') AS effective_scope,
                COUNT(*) AS count
         FROM sessions
         WHERE sessions.project_path = ?
           AND sessions.isArchived = 0` + accountVisibilitySql(accountVisibility, 'sessions') + `
         GROUP BY sessions.provider, effective_scope`
      )
      .all(normalizedProjectPath, getActiveAccountDir()) as Array<{
        provider: string;
        effective_scope: ServerScope;
        count: number;
      }>;

    return rows.map((row) => ({
      provider: row.provider,
      serverScope: row.effective_scope,
      count: Number(row.count),
    }));
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },
};
