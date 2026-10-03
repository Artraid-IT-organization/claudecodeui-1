/**
 * Реестр корпоративных подключений Devin (Connection Layer).
 *
 * Каждая строка — один серверный канал к Devin: каталог `xdg_data_home`
 * становится `XDG_DATA_HOME` дочернего `devin acp`, поэтому у канала своё
 * `credentials.toml` и своя `cli/sessions.db`. Сам секрет в таблице не лежит
 * никогда — здесь только метаданные и путь.
 *
 * Состояние канала:
 *   enabled        — админский выключатель; выключенный не выбирается
 *                    на новые ходы (уже прибитые чаты его не получают);
 *   priority       — меньше = раньше выбирается при равных условиях;
 *   health_status  — 'ok' | 'auth_failed' | 'rate_limited' | 'error' | 'unknown';
 *   cooldown_until — до этого момента канал не выбирается (rate limit и пр.).
 *   'auth_failed' лечится только заменой креды (см. providers-сервис).
 */
import { getConnection } from '@/modules/database/connection.js';

export type DevinConnectionHealth = 'ok' | 'auth_failed' | 'rate_limited' | 'error' | 'unknown';

export type DevinConnectionRow = {
  id: number;
  name: string;
  description: string;
  enabled: number;
  priority: number;
  xdg_data_home: string;
  health_status: DevinConnectionHealth;
  cooldown_until: string | null;
  last_error: string | null;
  last_health_check_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Каналы, доступные для нового хода: включённые, без живого cooldown,
 * без зафиксированной отозванной креды. Порядок — приоритет, затем id.
 */
const ELIGIBLE_WHERE = `
  WHERE enabled = 1
    AND health_status <> 'auth_failed'
    AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
`;

const ELIGIBLE_SQL = `
  SELECT * FROM devin_connections
  ${ELIGIBLE_WHERE}
  ORDER BY priority ASC, id ASC
`;

/** Слой данных для devin_connections. Потребители: providers/devin-connections.service, devin-runtime. */
export const devinConnectionsDb = {
  list(): DevinConnectionRow[] {
    return getConnection()
      .prepare('SELECT * FROM devin_connections ORDER BY priority ASC, id ASC')
      .all() as DevinConnectionRow[];
  },

  getById(id: number): DevinConnectionRow | null {
    return (getConnection()
      .prepare('SELECT * FROM devin_connections WHERE id = ?')
      .get(id) as DevinConnectionRow | undefined) ?? null;
  },

  getByName(name: string): DevinConnectionRow | null {
    return (getConnection()
      .prepare('SELECT * FROM devin_connections WHERE name = ?')
      .get(name) as DevinConnectionRow | undefined) ?? null;
  },

  /** Первый годный канал для нового хода или null, если все выключены/в кулдауне. */
  pickAvailable(): DevinConnectionRow | null {
    return (getConnection().prepare(`${ELIGIBLE_SQL} LIMIT 1`).get() as DevinConnectionRow | undefined) ?? null;
  },

  /** Годные каналы без уже перепробованных id — для фоллбэка внутри хода. */
  pickAvailableExcluding(excludedIds: number[]): DevinConnectionRow | null {
    if (excludedIds.length === 0) {
      return this.pickAvailable();
    }
    const marks = excludedIds.map(() => '?').join(',');
    return (getConnection()
      .prepare(
        `SELECT * FROM devin_connections
         ${ELIGIBLE_WHERE} AND id NOT IN (${marks})
         ORDER BY priority ASC, id ASC LIMIT 1`,
      )
      .get(...excludedIds) as DevinConnectionRow | undefined) ?? null;
  },

  create(input: {
    name: string;
    description?: string;
    priority?: number;
    xdgDataHome: string;
  }): DevinConnectionRow {
    const result = getConnection()
      .prepare(
        `INSERT INTO devin_connections (name, description, priority, xdg_data_home)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.name, input.description ?? '', input.priority ?? 0, input.xdgDataHome);
    return this.getById(Number(result.lastInsertRowid))!;
  },

  update(id: number, fields: {
    name?: string;
    description?: string;
    enabled?: boolean;
    priority?: number;
  }): DevinConnectionRow | null {
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
    if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
    if (fields.enabled !== undefined) { sets.push('enabled = ?'); params.push(fields.enabled ? 1 : 0); }
    if (fields.priority !== undefined) { sets.push('priority = ?'); params.push(fields.priority); }
    if (sets.length === 0) {
      return this.getById(id);
    }
    sets.push("updated_at = CURRENT_TIMESTAMP");
    getConnection()
      .prepare(`UPDATE devin_connections SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
    return this.getById(id);
  },

  /** Зафиксировать исход хода/пробы по каналу. `cooldownMinutes` — для rate_limited. */
  markHealth(id: number, health: DevinConnectionHealth, options?: {
    lastError?: string | null;
    cooldownMinutes?: number;
  }): void {
    getConnection()
      .prepare(
        `UPDATE devin_connections SET
           health_status = ?,
           last_error = ?,
           cooldown_until = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' minutes') END,
           last_health_check_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(health, options?.lastError ?? null, options?.cooldownMinutes ?? null, options?.cooldownMinutes ?? null, id);
  },

  /** Снять с канала диагноз (после замены креды): обратно в неизвестное, но годное. */
  resetHealth(id: number): void {
    getConnection()
      .prepare(
        `UPDATE devin_connections SET
           health_status = 'unknown',
           last_error = NULL,
           cooldown_until = NULL,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(id);
  },

  /** Сколько незаархивированных чатов прибито к каналу — «какие задачи через него идут». */
  countBoundSessions(id: number): number {
    const row = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE devin_connection_id = ? AND isArchived = 0`)
      .get(id) as { n: number };
    return row.n;
  },

  /** Чаты канала с автором — админке «какие задачи через него выполняются». */
  listBoundSessions(id: number, limit = 50): Array<{
    session_id: string;
    custom_name: string | null;
    initiated_by_user_id: number | null;
    initiator: string | null;
    created_at: string;
    updated_at: string;
    isArchived: number;
  }> {
    return getConnection()
      .prepare(
        `SELECT sessions.session_id, sessions.custom_name, sessions.initiated_by_user_id,
                users.username AS initiator, sessions.created_at, sessions.updated_at, sessions.isArchived
         FROM sessions LEFT JOIN users ON users.id = sessions.initiated_by_user_id
         WHERE sessions.devin_connection_id = ?
         ORDER BY sessions.updated_at DESC
         LIMIT ?`,
      )
      .all(id, limit) as Array<{
        session_id: string;
        custom_name: string | null;
        initiated_by_user_id: number | null;
        initiator: string | null;
        created_at: string;
        updated_at: string;
        isArchived: number;
      }>;
  },

  delete(id: number): boolean {
    const result = getConnection()
      .prepare('DELETE FROM devin_connections WHERE id = ?')
      .run(id);
    return result.changes > 0;
  },
};
