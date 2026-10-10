/**
 * Devin Connection Layer — сервис корпоративных каналов к Devin.
 *
 * Модель. Пользователи Cloud UI не логинятся в Devin сами: сервер держит
 * реестр каналов (`devin_connections`), каждый — каталог, который становится
 * `XDG_DATA_HOME` дочернего `devin acp`. Внутри каталога свои
 * `devin/credentials.toml` и `devin/cli/sessions.db`, поэтому каналы
 * изолированы друг от друга и от машинного дефолта.
 *
 * Линия и подписка — разные вещи (10.10.26). Канал чата
 * (`sessions.devin_connection_id`) — ЛИНИЯ: каталог, где лежит его
 * sessions.db; чат прибит к ней навсегда. Платит за ход ПОДПИСКА — креда
 * любого годного канала (`pickCredentialForLane`). Чужая креда подаётся
 * теневым XDG (`prepareTurnDataHome`): всё содержимое линии симлинками +
 * credentials.toml выбранной подписки. Так чат продолжается, когда у его
 * подписки кончился лимит — то же, что logout/login руками, только без
 * переключения машинной креды. Проверено вживую: сессия, начатая под одной
 * подпиской, продолжилась под другой с полной памятью.
 *
 * Здоровье канала: ошибки хода классифицируются (`classifyDevinFailure`) —
 * 'auth_failed' не пересматривается само (креда отозвана, ретраи бессмысленны),
 * 'rate_limited' ставит cooldown, остальное — 'error' без штрафа, следующий
 * запрос может пройти.
 *
 * Секреты: креда живёт только файлом 0600 в каталоге 0700; в БД — путь и
 * метаданные; в ответы API и логи содержимое не попадает.
 */
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import spawn from 'cross-spawn';

import { devinConnectionsDb, type DevinConnectionRow } from '@/modules/database/index.js';
import { AppError, getDevinConnectionsRoot, resolveDevinCliCommand } from '@/shared/utils.js';

/** Как долго канал с rate limit отдыхает, прежде чем его снова выберут. */
const RATE_LIMIT_COOLDOWN_MINUTES = 15;
/** Проба здоровья канала — живой вызов CLI, не «файл на месте». */
const HEALTH_CHECK_TIMEOUT_MS = 20_000;

/**
 * 'session_locked' — сессию держит другой процесс devin (предыдущий ход чата
 * ещё жив): подписка ни при чём, перебор подписок ничего не даст.
 */
export type DevinFailureClass = 'auth' | 'rate_limit' | 'session_locked' | 'transient';

const DEVIN_CONNECTION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Откуда брать «машинную» креды для канала по умолчанию. Каталог может быть
 * задан XDG_DATA_HOME процесса — считаем его по тем же правилам, что CLI.
 */
function defaultXdgDataHome(): string {
  return process.env.XDG_DATA_HOME?.trim() || path.join(process.env.HOME || '', '.local', 'share');
}

/**
 * Ленивый посев legacy-канала: при первом обращении, если реестр пуст, а
 * машинная креда существует — она становится connection «default» БЕЗ
 * копирования файлов (xdg указывает на общий домашний каталог). Площадки без
 * Devin получают пустой реестр — провайдер честно отвечает «не настроен».
 */
function ensureSeeded(): void {
  const existing = devinConnectionsDb.list();
  if (existing.length > 0) {
    return;
  }
  const xdg = defaultXdgDataHome();
  const credentialsPath = path.join(xdg, 'devin', 'credentials.toml');
  let hasCredentials = false;
  try {
    hasCredentials = fsSync.statSync(credentialsPath).size > 0;
  } catch {
    return; // машинной креды нет — сеять нечего
  }
  if (!hasCredentials) {
    return;
  }
  try {
    devinConnectionsDb.create({
      name: 'default',
      description: 'Legacy machine credential (migrated automatically)',
      priority: 0,
      xdgDataHome: xdg,
    });
  } catch {
    // Гонка двух параллельных сидов — второй попадает в UNIQUE и молча уходит.
  }
}

/**
 * Классификация сбоя канала по тексту ошибки/stderr Devin CLI.
 * Паттерны собраны с живых ответов (`auth status`, ACP errors): auth —
 * отозванная/битая креда, rate — лимиты и квоты, остальное — transient.
 */
export function classifyDevinFailure(message: string): DevinFailureClass {
  // Хвост «(trace ID: …) — журнал CLI» отбрасываем: в нём случайный hex и тайминги
  // вида `time.busy=403µs`, которые читались как HTTP 403 — и лимит становился
  // вечным auth_failed (бывший local-patch 0010). Коды статусов — целым словом.
  const text = message.toLowerCase().replace(/\(trace id:[\s\S]*$/, '');
  // Живой текст 10.10.26: «Session 'x' is already open in another process (PID n)»,
  // errorKind session_locked. Проверка первой: в хвосте stderr бывают и «403».
  if (/already open in another process|session_locked/.test(message.toLowerCase())) {
    return 'session_locked';
  }
  if (
    /\b40[13]\b|unauthori[sz]ed|not authenticated|authentication required|invalid (service key|token|credential)|no credentials|devin auth login/.test(text)
  ) {
    return 'auth';
  }
  if (/\b429\b|rate.?limit|too many requests|quota|usage limit|insufficient|exceeded|over.*limit/.test(text)) {
    return 'rate_limit';
  }
  return 'transient';
}

/** Можно ли попробовать другой канал при таком классе сбоя. */
export function isFailoverableFailure(cls: DevinFailureClass): boolean {
  // auth-тоже годится для фоллбэка: у следующего канала может быть живая креда.
  // session_locked — нет: замок на сессии в линии, его держит не подписка.
  return cls === 'auth' || cls === 'rate_limit' || cls === 'transient';
}

/**
 * Минуты до сброса лимита из текста Devin: «Your limit will reset in 34
 * minutes (at 21:01 UTC)». Берётся «at HH:MM UTC» (оно точнее «in N»), время в
 * прошлом — значит завтра. null — в тексте срока нет.
 */
function parseRateLimitResetMinutes(message: string, now: Date = new Date()): number | null {
  const at = /reset[^.]*\bat (\d{1,2}):(\d{2}) UTC/i.exec(message);
  if (!at) {
    return null;
  }
  const reset = new Date(now);
  reset.setUTCHours(Number(at[1]), Number(at[2]), 0, 0);
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 60_000));
}

/** Корень теневых XDG «линия + чужая креда»; реестр каналов его не знает и не сканирует. */
function getCredentialOverlaysRoot(): string {
  return path.join(getDevinConnectionsRoot(), '.overlays');
}

/**
 * Зеркалит каталог `sourceDir` в `overlayDir` симлинками (кроме `skip`).
 * Сначала возвращает в источник то, что процесс создал прямо в тени
 * (новые каталоги MCP-серверов, файлы CLI) — иначе эти данные жили бы
 * только в тени конкретной пары «линия + подписка». Висячие ссылки убираются,
 * иначе открытие с O_CREAT создало бы файл по старому адресу.
 */
function mirrorDirectoryWithSymlinks(sourceDir: string, overlayDir: string, skip: Set<string>): void {
  fsSync.mkdirSync(overlayDir, { recursive: true, mode: 0o700 });
  for (const entry of fsSync.readdirSync(overlayDir)) {
    if (skip.has(entry)) {
      continue;
    }
    const overlayEntry = path.join(overlayDir, entry);
    const sourceEntry = path.join(sourceDir, entry);
    const stat = fsSync.lstatSync(overlayEntry);
    if (stat.isSymbolicLink()) {
      if (!fsSync.existsSync(overlayEntry)) {
        fsSync.unlinkSync(overlayEntry);
      }
      continue;
    }
    if (!fsSync.existsSync(sourceEntry)) {
      try {
        fsSync.renameSync(overlayEntry, sourceEntry);
      } catch (error) {
        // Другая ФС или гонка с соседним ходом — запись остаётся в тени, ход не ломаем.
        console.warn(`[Devin] overlay: не вернул ${overlayEntry} в линию:`, (error as Error).message);
      }
    }
  }
  for (const entry of fsSync.readdirSync(sourceDir)) {
    if (skip.has(entry)) {
      continue;
    }
    const overlayEntry = path.join(overlayDir, entry);
    try {
      fsSync.lstatSync(overlayEntry);
    } catch {
      try {
        fsSync.symlinkSync(path.join(sourceDir, entry), overlayEntry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
  }
}

/**
 * credentials.toml тени = ссылка на креду подписки. Если CLI переписал её
 * настоящим файлом (атомарная запись при обновлении токена) — содержимое
 * относится к той же подписке и возвращается в её каталог, затем ссылка
 * ставится заново.
 */
function linkOverlayCredential(overlayDevinDir: string, credentialPath: string): void {
  const overlayCredential = path.join(overlayDevinDir, 'credentials.toml');
  let stat: fsSync.Stats | null = null;
  try {
    stat = fsSync.lstatSync(overlayCredential);
  } catch {
    stat = null;
  }
  if (stat?.isSymbolicLink() && fsSync.readlinkSync(overlayCredential) === credentialPath) {
    return;
  }
  if (stat && !stat.isSymbolicLink() && stat.isFile()) {
    const rewritten = fsSync.readFileSync(overlayCredential, 'utf8');
    if (/^\s*windsurf_api_key\s*=/m.test(rewritten)) {
      fsSync.writeFileSync(credentialPath, rewritten, { mode: 0o600 });
    }
  }
  if (stat) {
    fsSync.rmSync(overlayCredential, { force: true, recursive: true });
  }
  fsSync.symlinkSync(credentialPath, overlayCredential);
}

export type DevinConnectionView = {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  health: string;
  cooldownUntil: string | null;
  lastError: string | null;
  lastHealthCheckAt: string | null;
  boundSessions: number;
  hasCredentials: boolean;
  accountEmail: string | null;
};

function toView(row: DevinConnectionRow): DevinConnectionView {
  let hasCredentials = false;
  try {
    hasCredentials = fsSync.statSync(path.join(row.xdg_data_home, 'devin', 'credentials.toml')).size > 0;
  } catch {
    hasCredentials = false;
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    priority: row.priority,
    health: row.health_status,
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    lastHealthCheckAt: row.last_health_check_at,
    boundSessions: devinConnectionsDb.countBoundSessions(row.id),
    hasCredentials,
    accountEmail: row.account_email,
  };
}

/** Каналы корпоративного Devin. Потребители: provider.routes (админка), devin-runtime (выбор), watchers/synchronizers (каталоги). */
export const devinConnectionsService = {
  listConnections(): DevinConnectionView[] {
    ensureSeeded();
    return devinConnectionsDb.list().map(toView);
  },

  getConnection(id: number): DevinConnectionRow | null {
    ensureSeeded();
    return devinConnectionsDb.getById(id);
  },

  /**
   * Канал для НОВОГО хода. Выбранный человеком канал (`preferredId`) берётся,
   * если он годен и ещё не перепробован; иначе — первый годный по приоритету
   * (авто-фолбэк). Если ничего не годно — AppError.
   */
  pickConnection(excludedIds: number[] = [], preferredId: number | null = null): DevinConnectionRow {
    ensureSeeded();
    if (preferredId != null && !excludedIds.includes(preferredId) && devinConnectionsDb.isEligible(preferredId)) {
      return devinConnectionsDb.getById(preferredId)!;
    }
    const row = excludedIds.length === 0
      ? devinConnectionsDb.pickAvailable()
      : devinConnectionsDb.pickAvailableExcluding(excludedIds);
    if (!row) {
      throw new AppError(
        'No enabled Devin connection is currently available (all are disabled, in cooldown, or unauthenticated).',
        { code: 'DEVIN_CONNECTION_UNAVAILABLE', statusCode: 503 },
      );
    }
    return row;
  },

  /**
   * ЛИНИЯ существующего чата — канал, в чьём каталоге лежит его sessions.db.
   * Выключенный канал линией остаться может: выключение снимает его креду с
   * оплаты ходов, но история чата никуда не девается и платит за неё другая
   * подписка. Ошибка — только если канал удалён (каталога больше не знаем).
   */
  resolveLaneForSession(boundConnectionId: number): DevinConnectionRow {
    ensureSeeded();
    const lane = devinConnectionsDb.getById(boundConnectionId);
    if (!lane) {
      throw new AppError(`The Devin connection #${boundConnectionId} this session uses was deleted.`, {
        code: 'DEVIN_CONNECTION_GONE', statusCode: 410,
      });
    }
    return lane;
  },

  /**
   * ПОДПИСКА, которая оплатит ход чата на линии `lane`. Порядок: выбранная в
   * пикере (`preferredId`) → собственная креда линии → первая годная по
   * приоритету. Перепробованные в этом ходе (`excludedIds`) и негодные
   * (выключены, в cooldown, креда отозвана) пропускаются. Ничего не годно —
   * AppError, как у pickConnection.
   */
  pickCredentialForLane(lane: DevinConnectionRow, excludedIds: number[] = [], preferredId: number | null = null): DevinConnectionRow {
    ensureSeeded();
    const usable = (id: number) => !excludedIds.includes(id) && devinConnectionsDb.isEligible(id);
    if (preferredId != null && usable(preferredId)) {
      return devinConnectionsDb.getById(preferredId)!;
    }
    if (usable(lane.id)) {
      return lane;
    }
    return this.pickConnection(excludedIds);
  },

  /**
   * XDG_DATA_HOME хода: линия чата, если платит её собственная креда; иначе
   * теневой каталог `<root>/.overlays/lane-<L>-cred-<C>` — всё содержимое
   * линии симлинками (sessions.db, transcripts, MCP-данные пишутся в линию),
   * кроме `devin/credentials.toml`, который указывает на креду подписки.
   * Тень пересобирается перед каждым ходом и общая для всех чатов пары.
   */
  prepareTurnDataHome(lane: DevinConnectionRow, credential: DevinConnectionRow): string {
    if (lane.id === credential.id) {
      return lane.xdg_data_home;
    }
    const overlay = path.join(getCredentialOverlaysRoot(), `lane-${lane.id}-cred-${credential.id}`);
    fsSync.mkdirSync(getCredentialOverlaysRoot(), { recursive: true, mode: 0o700 });
    const laneDevinDir = path.join(lane.xdg_data_home, 'devin');
    fsSync.mkdirSync(laneDevinDir, { recursive: true, mode: 0o700 });
    mirrorDirectoryWithSymlinks(lane.xdg_data_home, overlay, new Set(['devin']));
    mirrorDirectoryWithSymlinks(laneDevinDir, path.join(overlay, 'devin'), new Set(['credentials.toml']));
    linkOverlayCredential(path.join(overlay, 'devin'), path.join(credential.xdg_data_home, 'devin', 'credentials.toml'));
    return overlay;
  },

  /**
   * Наследие: чат знает свой devinSessionId, но не привязан к каналу. Ищем,
   * в ЧЬЕЙ sessions.db эта сессия лежит, и возвращаем этот канал — иначе
   * session/load уйдёт в базу другого канала и честно не найдёт историю.
   * Нашли → чат прибивается к найденному каналу (в рантайме).
   */
  findConnectionHostingSession(providerSessionId: string): DevinConnectionRow | null {
    ensureSeeded();
    // Выключенные каналы тоже: линией чата канал остаётся и выключенным.
    for (const conn of devinConnectionsDb.list()) {
      const dbPath = path.join(conn.xdg_data_home, 'devin', 'cli', 'sessions.db');
      if (!fsSync.existsSync(dbPath)) {
        continue;
      }
      try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
          const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(providerSessionId);
          if (row) {
            return conn;
          }
        } finally {
          db.close();
        }
      } catch {
        // База недоступна/битая — канал пропускаем.
      }
    }
    return null;
  },

  createConnection(input: { name: string; description?: string; priority?: number }): DevinConnectionView {
    ensureSeeded();
    const name = input.name?.trim();
    if (!name || !DEVIN_CONNECTION_NAME_PATTERN.test(name)) {
      throw new AppError('Connection name must be 1-64 chars of [a-zA-Z0-9._-] starting with alphanumeric.', {
        code: 'INVALID_CONNECTION_NAME', statusCode: 400,
      });
    }
    if (devinConnectionsDb.getByName(name)) {
      throw new AppError(`Devin connection "${name}" already exists.`, {
        code: 'CONNECTION_EXISTS', statusCode: 409,
      });
    }

    // Каталог канала = его XDG_DATA_HOME; имя по uuid, а не по id — каталог не
    // зависит ни от переименования, ни от порядка INSERT'а.
    const xdgDataHome = path.join(getDevinConnectionsRoot(), `conn-${randomUUID().slice(0, 8)}`);
    fsSync.mkdirSync(path.join(xdgDataHome, 'devin'), { recursive: true, mode: 0o700 });
    fsSync.chmodSync(xdgDataHome, 0o700);
    fsSync.chmodSync(path.join(xdgDataHome, 'devin'), 0o700);

    const row = devinConnectionsDb.create({
      name,
      description: input.description ?? '',
      priority: input.priority ?? 0,
      xdgDataHome,
    });
    return toView(row);
  },

  updateConnection(id: number, fields: { name?: string; description?: string; enabled?: boolean; priority?: number; accountEmail?: string | null }): DevinConnectionView {
    ensureSeeded();
    const row = devinConnectionsDb.getById(id);
    if (!row) {
      throw new AppError(`Devin connection #${id} was not found.`, { code: 'CONNECTION_NOT_FOUND', statusCode: 404 });
    }
    if (fields.name !== undefined) {
      const name = fields.name.trim();
      if (!DEVIN_CONNECTION_NAME_PATTERN.test(name)) {
        throw new AppError('Connection name must be 1-64 chars of [a-zA-Z0-9._-] starting with alphanumeric.', {
          code: 'INVALID_CONNECTION_NAME', statusCode: 400,
        });
      }
      const clash = devinConnectionsDb.getByName(name);
      if (clash && clash.id !== id) {
        throw new AppError(`Devin connection "${name}" already exists.`, { code: 'CONNECTION_EXISTS', statusCode: 409 });
      }
      fields.name = name;
    }
    if (fields.accountEmail !== undefined && fields.accountEmail !== null) {
      // Ярлык канала в пикере аккаунтов: обычно почта подписки, но поле свободное —
      // у devin CLI почту из auth status не прочитать, ярлык ставит владелец.
      const label = fields.accountEmail.trim();
      if (label.length === 0 || label.length > 254) {
        throw new AppError('accountEmail must be 1-254 chars or null to clear.', { code: 'INVALID_ACCOUNT_EMAIL', statusCode: 400 });
      }
      fields.accountEmail = label;
    }
    const updated = devinConnectionsDb.update(id, fields);
    return toView(updated!);
  },

  /** Чаты, идущие через канал: sessionId, название, автор, время. Админка. */
  listTasks(id: number) {
    ensureSeeded();
    if (!devinConnectionsDb.getById(id)) {
      throw new AppError(`Devin connection #${id} was not found.`, { code: 'CONNECTION_NOT_FOUND', statusCode: 404 });
    }
    return devinConnectionsDb.listBoundSessions(id);
  },

  deleteConnection(id: number): void {
    ensureSeeded();
    const row = devinConnectionsDb.getById(id);
    if (!row) {
      throw new AppError(`Devin connection #${id} was not found.`, { code: 'CONNECTION_NOT_FOUND', statusCode: 404 });
    }
    const bound = devinConnectionsDb.countBoundSessions(id);
    if (bound > 0) {
      throw new AppError(
        `Devin connection "${row.name}" still owns ${bound} session(s) — disable it instead of deleting.`,
        { code: 'CONNECTION_IN_USE', statusCode: 409 },
      );
    }
    devinConnectionsDb.delete(id);
    // Каталог с кредами намеренно оставляем на диске: удаление — операция
    // обратимая, файлы убираются руками администратора, не аппаратом.
  },

  /**
   * Установить/заменить креду канала. Принимает готовое содержимое
   * credentials.toml (формат `devin auth login`) — файл валидируется по
   * наличию windsurf_api_key, кладётся на диск 0600, затем прогоняется живая
   * проба. Креда в ответ не возвращается и в лог не пишется.
   */
  async installCredential(id: number, credentialsToml: string): Promise<DevinConnectionView> {
    ensureSeeded();
    const row = devinConnectionsDb.getById(id);
    if (!row) {
      throw new AppError(`Devin connection #${id} was not found.`, { code: 'CONNECTION_NOT_FOUND', statusCode: 404 });
    }
    const text = credentialsToml?.trim() ?? '';
    if (!/^\s*windsurf_api_key\s*=/m.test(text) || !/api_server_url\s*=/m.test(text)) {
      throw new AppError(
        'Credential payload must be a Devin credentials.toml containing windsurf_api_key and api_server_url.',
        { code: 'INVALID_CREDENTIAL_FORMAT', statusCode: 400 },
      );
    }
    const devinDir = path.join(row.xdg_data_home, 'devin');
    fsSync.mkdirSync(devinDir, { recursive: true, mode: 0o700 });
    fsSync.chmodSync(row.xdg_data_home, 0o700);
    fsSync.chmodSync(devinDir, 0o700);
    const credentialsPath = path.join(devinDir, 'credentials.toml');
    fsSync.writeFileSync(credentialsPath, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
    fsSync.chmodSync(credentialsPath, 0o600);

    // Новая креда снимает старый диагноз до пробы — auth_failed лечится только так.
    devinConnectionsDb.resetHealth(id);
    await this.checkHealth(id);
    return toView(devinConnectionsDb.getById(id)!);
  },

  /**
   * Живая проба канала: `devin auth status` с его XDG_DATA_HOME. «Logged in» +
   * блок User → ok; «Authentication required»/«not authenticated» →
   * auth_failed; таймаут/сетевой сбой — error (креда может быть жива, канал
   * просто недоступен сейчас).
   */
  async checkHealth(id: number): Promise<DevinConnectionView> {
    ensureSeeded();
    const row = devinConnectionsDb.getById(id);
    if (!row) {
      throw new AppError(`Devin connection #${id} was not found.`, { code: 'CONNECTION_NOT_FOUND', statusCode: 404 });
    }
    const result = await new Promise<{ stdout: string; code: number | null }>((resolve) => {
      const child = spawn(resolveDevinCliCommand(), ['auth', 'status'], {
        env: { ...process.env, XDG_DATA_HOME: row.xdg_data_home },
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      });
      let stdout = '';
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.on('error', () => resolve({ stdout, code: null }));
      child.on('close', (code) => resolve({ stdout, code }));
    });
    const lower = result.stdout.toLowerCase();
    const accountEmail = /^\s*email:\s*(\S+)/im.exec(result.stdout)?.[1] ?? undefined;
    if (/logged in/.test(lower) && !/authentication required|failed to fetch/.test(lower)) {
      devinConnectionsDb.markHealth(id, 'ok', { lastError: null, accountEmail });
    } else if (/authentication required|not authenticated|invalid service key/.test(lower)) {
      devinConnectionsDb.markHealth(id, 'auth_failed', { lastError: 'devin auth status: authentication required' });
    } else {
      devinConnectionsDb.markHealth(id, 'error', { lastError: 'auth status inconclusive (CLI unreachable or timed out)' });
    }
    return toView(devinConnectionsDb.getById(id)!);
  },

  /**
   * Отметка исхода хода. Вызывается рантаймом: успех → 'ok' + сброс cooldown;
   * сбой → классификация, rate_limit ставит cooldown на RATE_LIMIT_COOLDOWN_MINUTES.
   * Текст ошибки в БД уходит усечённым — там бывают куски stderr.
   */
  recordOutcome(id: number, outcome: 'ok' | 'failed', errorMessage?: string): void {
    if (outcome === 'ok') {
      devinConnectionsDb.markHealth(id, 'ok', { lastError: null });
      return;
    }
    const cls = classifyDevinFailure(errorMessage ?? '');
    const clipped = (errorMessage ?? '').slice(0, 500);
    if (cls === 'session_locked') {
      return; // подписка здорова — занят чат, а не она
    }
    if (cls === 'auth') {
      devinConnectionsDb.markHealth(id, 'auth_failed', { lastError: clipped });
    } else if (cls === 'rate_limit') {
      // Devin называет время сброса — подписка отдыхает ровно до него, а не 15 мин наугад.
      const cooldownMinutes = parseRateLimitResetMinutes(errorMessage ?? '') ?? RATE_LIMIT_COOLDOWN_MINUTES;
      devinConnectionsDb.markHealth(id, 'rate_limited', { lastError: clipped, cooldownMinutes });
    } else {
      devinConnectionsDb.markHealth(id, 'error', { lastError: clipped });
    }
  },
};
