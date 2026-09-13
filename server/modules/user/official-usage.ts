/**
 * Расход подписки из того же источника, что и команда `/usage` в Claude Code.
 *
 * Прежний показатель собирался из двух косвенных мест: кэша
 * `cachedUsageUtilization` в ~/.claude.json и события лимитов из потока
 * ответа. Оба подвели. Свежий CLI кэш в файл больше не пишет — полосы молча
 * пропали; событие из потока приходит только во время работы и не по всем
 * окнам, так что проценты расходились с тем, что показывает сам Клод.
 * Егор 13.09.26: «раньше она была, но ошибочная… пусть будет рабочая».
 *
 * Здесь — прямой запрос `GET api.anthropic.com/api/oauth/usage` с ключом
 * входа этого аккаунта. Это справочный запрос, а не сообщение модели: квоту он
 * не расходует. Ответ уже содержит готовые окна (`limits`) с процентами и
 * временем сброса — ровно те числа, что видит человек в `/usage`.
 *
 * Ключ только читаем и НИКОГДА не продлеваем: продление меняет ключ
 * обновления, и у CLI, который пользуется тем же файлом, слетел бы вход
 * (см. правило «Ключи входа Claude» в ~/CLAUDE.md). Ключ истёк — значит, CLI
 * давно не работал; тогда отдаём последнее удачное значение с его временем.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Чаще раза в минуту спрашивать незачем: панель обновляется раз в две. */
const CACHE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;

export type OfficialUsageLimit = {
  kind: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  modelName: string | null;
  expired: boolean;
};

export type OfficialUsage = {
  fetchedAtMs: number;
  limits: OfficialUsageLimit[];
};

type CacheEntry = { checkedAtMs: number; value: OfficialUsage | null };

const cacheByAccountDir = new Map<string, CacheEntry>();
const lastGoodByAccountDir = new Map<string, OfficialUsage>();

async function readAccessToken(accountDir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(accountDir, '.credentials.json'), 'utf-8');
    const oauth = (JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    }).claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
      return null;
    }
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) {
      return null;
    }
    return oauth.accessToken;
  } catch {
    return null;
  }
}

/** Разбор ответа отдельно от сети — чтобы проверять его тестом. */
export function parseOfficialUsage(body: unknown, nowMs: number): OfficialUsage | null {
  const rows = (body as { limits?: unknown } | null)?.limits;
  if (!Array.isArray(rows)) {
    return null;
  }

  const limits: OfficialUsageLimit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const item = row as {
      kind?: unknown;
      percent?: unknown;
      severity?: unknown;
      resets_at?: unknown;
      scope?: { model?: { display_name?: unknown } } | null;
    };
    if (typeof item.percent !== 'number' || !Number.isFinite(item.percent)) {
      continue;
    }
    const resetsAt = typeof item.resets_at === 'string' ? item.resets_at : null;
    const resetsAtMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    const modelName = item.scope?.model?.display_name;
    limits.push({
      kind: typeof item.kind === 'string' ? item.kind : 'unknown',
      percent: Math.max(0, Math.min(100, Math.round(item.percent))),
      severity: typeof item.severity === 'string' ? item.severity : 'normal',
      resetsAt,
      modelName: typeof modelName === 'string' ? modelName : null,
      expired: Number.isFinite(resetsAtMs) ? resetsAtMs <= nowMs : false,
    });
  }

  return limits.length > 0 ? { fetchedAtMs: nowMs, limits } : null;
}

/**
 * Расход аккаунта, живущего в этом каталоге настроек. `null` — узнать нечем
 * (нет входа, сеть недоступна и удачного значения раньше не было).
 */
export async function getOfficialUsage(accountDir: string): Promise<OfficialUsage | null> {
  if (!accountDir) {
    return null;
  }

  const cached = cacheByAccountDir.get(accountDir);
  if (cached && Date.now() - cached.checkedAtMs < CACHE_TTL_MS) {
    return cached.value ?? lastGoodByAccountDir.get(accountDir) ?? null;
  }

  let value: OfficialUsage | null = null;
  const token = await readAccessToken(accountDir);
  if (token) {
    try {
      const response = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        value = parseOfficialUsage(await response.json(), Date.now());
      }
    } catch {
      // Сеть или таймаут: ниже отдадим последнее удачное значение.
    }
  }

  cacheByAccountDir.set(accountDir, { checkedAtMs: Date.now(), value });
  if (value) {
    lastGoodByAccountDir.set(accountDir, value);
    return value;
  }
  return lastGoodByAccountDir.get(accountDir) ?? null;
}
