/**
 * Devin Connection Layer — сервис корпоративных каналов к Devin.
 *
 * Модель. Пользователи Cloud UI не логинятся в Devin сами: сервер держит
 * реестр каналов (`devin_connections`), каждый — каталог, который становится
 * `XDG_DATA_HOME` дочернего `devin acp`. Внутри каталога свои
 * `devin/credentials.toml` и `devin/cli/sessions.db`, поэтому каналы
 * изолированы друг от друга и от машинного дефолта.
 *
 * Выбор канала на ход: `resolveConnectionForSession` — прибитый чат
 * (`sessions.devin_connection_id`) идёт через свой канал всегда (sessions.db
 * лежит внутри его каталога, иначе resume не найдёт сессию); новый чат берёт
 * первый годный по приоритету.
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

export type DevinFailureClass = 'auth' | 'rate_limit' | 'transient';

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
  const text = message.toLowerCase();
  if (
    /401|403|unauthori[sz]ed|not authenticated|authentication required|invalid (service key|token|credential)|no credentials|devin auth login/.test(text)
  ) {
    return 'auth';
  }
  if (/429|rate.?limit|too many requests|quota|usage limit|insufficient|exceeded|over.*limit/.test(text)) {
    return 'rate_limit';
  }
  return 'transient';
}

/** Можно ли попробовать другой канал при таком классе сбоя. */
export function isFailoverableFailure(cls: DevinFailureClass): boolean {
  // auth-тоже годится для фоллбэка: у следующего канала может быть живая креда.
  return cls === 'auth' || cls === 'rate_limit' || cls === 'transient';
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
   * Канал существующего чата. Прибитый чат обязан идти через свой канал —
   * sessions.db физически лежит в его каталоге. Выключенный канал для resume
   * даёт понятную ошибку, а не тихий перескок (чужая sessions.db сессию не
   * знает — молчаливый failover создавал бы «другой» чат с той же историей).
   */
  resolveConnectionForSession(sessionId: string | null | undefined, boundConnectionId: number | null | undefined): DevinConnectionRow {
    ensureSeeded();
    if (boundConnectionId != null) {
      const bound = devinConnectionsDb.getById(boundConnectionId);
      if (!bound) {
        throw new AppError(`The Devin connection #${boundConnectionId} this session uses was deleted.`, {
          code: 'DEVIN_CONNECTION_GONE', statusCode: 410,
        });
      }
      if (!bound.enabled) {
        throw new AppError(`Devin connection "${bound.name}" is disabled — enable it to resume this session.`, {
          code: 'DEVIN_CONNECTION_DISABLED', statusCode: 503,
        });
      }
      return bound;
    }
    void sessionId;
    return this.pickConnection();
  },

  /**
   * Наследие: чат знает свой devinSessionId, но не привязан к каналу. Ищем,
   * в ЧЬЕЙ sessions.db эта сессия лежит, и возвращаем этот канал — иначе
   * session/load уйдёт в базу другого канала и честно не найдёт историю.
   * Нашли → чат прибивается к найденному каналу (в рантайме).
   */
  findConnectionHostingSession(providerSessionId: string): DevinConnectionRow | null {
    ensureSeeded();
    for (const conn of devinConnectionsDb.list()) {
      if (!conn.enabled) {
        continue;
      }
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
    if (cls === 'auth') {
      devinConnectionsDb.markHealth(id, 'auth_failed', { lastError: clipped });
    } else if (cls === 'rate_limit') {
      devinConnectionsDb.markHealth(id, 'rate_limited', { lastError: clipped, cooldownMinutes: RATE_LIMIT_COOLDOWN_MINUTES });
    } else {
      devinConnectionsDb.markHealth(id, 'error', { lastError: clipped });
    }
  },
};
