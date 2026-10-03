import path from 'node:path';
import { readFile } from 'node:fs/promises';

import TOML from '@iarna/toml';

import { getDevinDataDir } from '@/shared/utils.js';

/**
 * Devin subscription account and its quota windows, read from the same
 * Codeium-family endpoint the `devin` CLI uses for `/usage`:
 * `POST <api_server_url>/exa.api_server_pb.ApiServerService/GetUserStatus`
 * with the machine credential (`<XDG_DATA_HOME>/devin/credentials.toml`,
 * installed by `devin auth login` or by the Connection Layer admin page).
 *
 * Devin's planStatus reports REMAINING percents (`dailyQuotaRemainingPercent`,
 * `weeklyQuotaRemainingPercent`) and reset times as unix seconds — there is
 * no 5-hour window at all, daily and weekly only. The panel shows "used"
 * percents, so values are inverted here (100 - remaining).
 *
 * This is a read-only metering call: it does not spend the quota it shows.
 * The credential is only read from disk and sent to its own API server —
 * never logged, never returned to the client.
 */

type DevinUsageWindow = {
  /** `daily` = 24 h quota window, `weekly` = 7-day quota window. */
  kind: 'daily' | 'weekly';
  /** Percent of the window already spent (0-100). */
  percent: number;
  resetsAt: string | null;
  windowMinutes: number;
  expired: boolean;
};

export type DevinAccountLimits = {
  available: boolean;
  email: string | null;
  planName: string | null;
  fetchedAtMs: number | null;
  limits: DevinUsageWindow[];
};

/** A fresh read at most this often: the panel polls every two minutes. */
const CACHE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;

const EMPTY: DevinAccountLimits = {
  available: false, email: null, planName: null, fetchedAtMs: null, limits: [],
};

const cacheByDataDir = new Map<string, { checkedAtMs: number; value: DevinAccountLimits }>();
const lastGoodByDataDir = new Map<string, DevinAccountLimits>();

type DevinCredentials = { apiKey: string; apiServerUrl: string };

/** Reads the Devin CLI credential file; null when absent or keyless. */
async function readCredentials(dataDir: string): Promise<DevinCredentials | null> {
  try {
    const raw = await readFile(path.join(dataDir, 'credentials.toml'), 'utf-8');
    const parsed = TOML.parse(raw) as {
      windsurf_api_key?: unknown;
      api_server_url?: unknown;
    };
    const apiKey = typeof parsed.windsurf_api_key === 'string' ? parsed.windsurf_api_key.trim() : '';
    const apiServerUrl = typeof parsed.api_server_url === 'string' ? parsed.api_server_url.trim() : '';
    if (!apiKey || !apiServerUrl) {
      return null;
    }
    return { apiKey, apiServerUrl };
  } catch {
    return null;
  }
}

function readUnixSeconds(value: unknown): number | null {
  const seconds = typeof value === 'string' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function toWindow(
  kind: 'daily' | 'weekly',
  remainingPercent: unknown,
  resetAtUnix: unknown,
  hidden: boolean,
  nowMs: number,
): DevinUsageWindow | null {
  if (hidden || typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent)) {
    return null;
  }
  const resetAtSec = readUnixSeconds(resetAtUnix);
  const resetsAtMs = resetAtSec !== null ? resetAtSec * 1000 : Number.NaN;
  // planStatus отдаёт ОСТАТОК квоты — в показ переводим как «израсходовано».
  const usedPercent = Math.max(0, Math.min(100, Math.round(100 - remainingPercent)));
  return {
    kind,
    percent: usedPercent,
    resetsAt: Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null,
    windowMinutes: kind === 'daily' ? 1440 : 10080,
    expired: Number.isFinite(resetsAtMs) ? resetsAtMs <= nowMs : false,
  };
}

function isHidden(...flags: unknown[]): boolean {
  return flags.some((flag) => flag === true);
}

/** Разбор ответа GetUserStatus отдельно от сети — чтобы проверять его тестом. */
export function parseDevinAccountUsage(body: unknown, nowMs: number): DevinAccountLimits {
  const userStatus = (body as { userStatus?: unknown } | null)?.userStatus;
  if (!userStatus || typeof userStatus !== 'object') {
    return { ...EMPTY };
  }
  const status = userStatus as {
    email?: unknown;
    planStatus?: {
      planInfo?: { planName?: unknown; hideDailyQuota?: unknown; hideWeeklyQuota?: unknown; devinInfo?: { hideDailyQuota?: unknown; hideWeeklyQuota?: unknown } | null };
      dailyQuotaRemainingPercent?: unknown;
      weeklyQuotaRemainingPercent?: unknown;
      dailyQuotaResetAtUnix?: unknown;
      weeklyQuotaResetAtUnix?: unknown;
    } | null;
    teamConfig?: { hideDailyQuota?: unknown; hideWeeklyQuota?: unknown } | null;
  };
  const plan = status.planStatus;
  if (!plan || typeof plan !== 'object') {
    return { ...EMPTY };
  }

  const limits = [
    toWindow(
      'daily',
      plan.dailyQuotaRemainingPercent,
      plan.dailyQuotaResetAtUnix,
      isHidden(plan.planInfo?.hideDailyQuota, plan.planInfo?.devinInfo?.hideDailyQuota, status.teamConfig?.hideDailyQuota),
      nowMs,
    ),
    toWindow(
      'weekly',
      plan.weeklyQuotaRemainingPercent,
      plan.weeklyQuotaResetAtUnix,
      isHidden(plan.planInfo?.hideWeeklyQuota, plan.planInfo?.devinInfo?.hideWeeklyQuota, status.teamConfig?.hideWeeklyQuota),
      nowMs,
    ),
  ].filter((window): window is DevinUsageWindow => window !== null);

  const planName = plan.planInfo?.planName;
  return {
    available: true,
    email: typeof status.email === 'string' && status.email ? status.email : null,
    planName: typeof planName === 'string' && planName ? planName : null,
    fetchedAtMs: limits.length > 0 ? nowMs : null,
    limits,
  };
}

/**
 * Devin account (email, plan) and its daily/weekly quota windows for the
 * credential at `getDevinDataDir(xdgDataHome)`. Cached per data dir for a
 * minute with the last good answer kept on failures — same contract as the
 * Claude/Codex readers. `available: false` when there is no credential file.
 *
 * Consumer: user module (GET /api/user/devin-account) - the "Расход" panel.
 */
export async function readDevinAccountLimits(xdgDataHome?: string | null): Promise<DevinAccountLimits> {
  const dataDir = getDevinDataDir(xdgDataHome);
  const cached = cacheByDataDir.get(dataDir);
  if (cached && Date.now() - cached.checkedAtMs < CACHE_TTL_MS) {
    return cached.value;
  }

  const credentials = await readCredentials(dataDir);
  if (!credentials) {
    const empty = { ...EMPTY };
    cacheByDataDir.set(dataDir, { checkedAtMs: Date.now(), value: empty });
    return empty;
  }

  let value: DevinAccountLimits = lastGoodByDataDir.get(dataDir) ?? { ...EMPTY };
  try {
    const response = await fetch(
      `${credentials.apiServerUrl.replace(/\/+$/, '')}/exa.api_server_pb.ApiServerService/GetUserStatus`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          metadata: {
            apiKey: credentials.apiKey,
            ideName: 'devin-cli',
            ideVersion: '1',
            extensionName: 'devin-cli',
            extensionVersion: '1',
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (response.ok) {
      const parsed = parseDevinAccountUsage(await response.json(), Date.now());
      if (parsed.available) {
        value = parsed;
      }
    }
  } catch {
    // Сеть или таймаут: отдаём последнее удачное значение.
  }

  cacheByDataDir.set(dataDir, { checkedAtMs: Date.now(), value });
  if (value.available) {
    lastGoodByDataDir.set(dataDir, value);
  }
  return value;
}
