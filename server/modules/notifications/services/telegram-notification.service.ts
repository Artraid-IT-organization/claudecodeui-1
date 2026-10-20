/**
 * Telegram-канал доставки уведомлений.
 *
 * Адресаты хранятся в notification_channel_endpoints (channel='telegram',
 * endpoint_id = chat_id); привязку создаёт связка «одноразовый код в боте +
 * ~/scripts/tg_router.py», сервер здесь только читает. Числовой chat_id —
 * единственный идентификатор: username в Telegram переуступаем.
 *
 * Креды не дублируются в app.env: читаются из process.env, а при отсутствии —
 * из ~/.env (тот же файл читает claude-tg-bot и tg.py). TG_API_SERVER указывает
 * на собственный сервер Bot API (127.0.0.1:8086), без него — облако.
 *
 * Административное зеркало: если у привязки metadata.mirror !== false и
 * глобально TG_NOTIFY_ADMIN_MIRROR не выключен, копия уходит в
 * TG_ADMIN_MIRROR_CHAT_ID (по умолчанию TG_CEO_CHAT_ID) с шапкой
 * «[Claude UI · <username>]». Себе администратор копий не шлёт — его own
 * уведомления и так приходят ему.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { notificationChannelEndpointsDb } from '@/modules/database/index.js';

type TelegramChannelConfig = {
  botToken: string;
  apiRoot: string;
  adminMirrorChatId: string;
  adminMirrorEnabled: boolean;
};

type TelegramEndpoint = {
  endpoint_id: string;
  metadata: {
    tg_user_id?: number;
    tg_username?: string | null;
    cc2_username?: string;
    mirror?: boolean;
  };
};

type NotificationPayloadForTelegram = {
  title: string;
  body: string;
  data?: { sessionName?: string | null; code?: string };
};

const CLOUD_API_ROOT = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 30000;
// Телеграм отвечает 403/400, когда бот заблокирован пользователем или чат
// исчез. Такие точки отключаем, иначе каждая попытка будет долбиться в закрытое.
const DEAD_ENDPOINT_MARKERS = [
  'bot was blocked',
  'user is deactivated',
  'chat not found',
  'bot was kicked',
  'group chat was deactivated',
];

function readEnvFileValue(key: string): string {
  try {
    const envPath = path.join(os.homedir(), '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) {
        return trimmed.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // Нет ~/.env — значит работаем только на переменных окружения.
  }
  return '';
}

function readSetting(key: string): string {
  return process.env[key] || readEnvFileValue(key);
}

/**
 * Конфигурация канала. Бот один и тот же, что у всей Telegram-обвязки сервера:
 * токен из окружения службы или ~/.env, свой Bot API сервер при наличии.
 */
export function getTelegramChannelConfig(): TelegramChannelConfig {
  const mirrorSwitch = readSetting('TG_NOTIFY_ADMIN_MIRROR').toLowerCase();
  return {
    botToken: readSetting('TG_BOT_TOKEN'),
    apiRoot: readSetting('TG_API_SERVER').replace(/\/$/, '') || CLOUD_API_ROOT,
    adminMirrorChatId: readSetting('TG_ADMIN_MIRROR_CHAT_ID') || readSetting('TG_CEO_CHAT_ID'),
    adminMirrorEnabled: !['0', 'off', 'false', 'no'].includes(mirrorSwitch),
  };
}

async function callTelegramApi(
  config: TelegramChannelConfig,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; description?: string }> {
  const url = `${config.apiRoot}/bot${config.botToken}/${method}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const result = await response.json().catch(() => ({
        ok: false,
        description: `HTTP ${response.status}`,
      })) as { ok: boolean; description?: string; parameters?: { retry_after?: number } };
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt === 0) {
        const waitMs = Math.min((result.parameters?.retry_after ?? 2), 10) * 1000;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      return result;
    } catch (error) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      return { ok: false, description: `network: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: false, description: 'unreachable' };
}

function isDeadEndpoint(description: string): boolean {
  const text = description.toLowerCase();
  return DEAD_ENDPOINT_MARKERS.some((marker) => text.includes(marker));
}

function formatUserText(payload: NotificationPayloadForTelegram): string {
  return `${payload.title}\n\n${payload.body}`;
}

function formatAdminMirrorText(username: string, payload: NotificationPayloadForTelegram): string {
  const lines = [`[Claude UI · ${username}]`];
  if (payload.data?.sessionName) {
    lines.push(`Задача: ${payload.data.sessionName}`);
  }
  if (payload.data?.code) {
    lines.push(`Событие: ${payload.data.code}`);
  }
  lines.push(`Время: ${new Date().toISOString()}`);
  lines.push('', formatUserText(payload));
  return lines.join('\n');
}

function parseEndpointMetadata(raw: string | null): TelegramEndpoint['metadata'] {
  return notificationChannelEndpointsDb.parseMetadata(raw) as TelegramEndpoint['metadata'];
}

/**
 * Отправка события оркестратора в Telegram. Вызывается каналом 'telegram' из
 * notification-orchestrator для каждого события, у которого у пользователя
 * включен канал telegram в prefs.
 *
 * Каждый получатель изолирован: ошибка доставки одному не отменяет остальных.
 * Мёртвые чаты (бот заблокирован, чат удалён) отключаются в endpoints, чтобы
 * не долбиться в закрытое; администратору об этом приходит отдельное сообщение.
 */
export async function sendTelegramNotification({
  userId,
  payload,
}: {
  userId: number;
  payload: NotificationPayloadForTelegram;
}): Promise<void> {
  const config = getTelegramChannelConfig();
  if (!config.botToken) {
    return;
  }
  const endpoints = notificationChannelEndpointsDb.getEnabledEndpoints(userId, 'telegram');
  if (!endpoints.length) {
    return;
  }

  const userText = formatUserText(payload);
  await Promise.allSettled(endpoints.map(async (endpoint) => {
    const result = await callTelegramApi(config, 'sendMessage', {
      chat_id: endpoint.endpoint_id,
      text: userText.slice(0, 4096),
      disable_web_page_preview: true,
    });
    if (result.ok) {
      notificationChannelEndpointsDb.touchEndpoint(userId, 'telegram', endpoint.endpoint_id);
      return;
    }
    const description = String(result.description || 'unknown error');
    if (isDeadEndpoint(description)) {
      notificationChannelEndpointsDb.setEndpointEnabled(userId, 'telegram', endpoint.endpoint_id, false);
      await notifyAdminBindingLost(config, endpoint, description);
      return;
    }
    console.error(`Telegram notification to ${endpoint.endpoint_id} failed: ${description}`);
  }));

  const primary = endpoints[0];
  const metadata = parseEndpointMetadata(primary.metadata_json);
  const mirrorAllowed = config.adminMirrorEnabled && metadata.mirror !== false;
  if (!mirrorAllowed || !config.adminMirrorChatId || config.adminMirrorChatId === primary.endpoint_id) {
    return;
  }
  const username = metadata.cc2_username || `user #${userId}`;
  await callTelegramApi(config, 'sendMessage', {
    chat_id: config.adminMirrorChatId,
    text: formatAdminMirrorText(username, payload).slice(0, 4096),
    disable_web_page_preview: true,
  }).then((result) => {
    if (!result.ok) {
      console.error(`Telegram admin mirror failed: ${result.description}`);
    }
  });
}

async function notifyAdminBindingLost(
  config: TelegramChannelConfig,
  endpoint: { endpoint_id: string; metadata_json: string | null },
  description: string,
): Promise<void> {
  if (!config.adminMirrorChatId) {
    return;
  }
  const metadata = parseEndpointMetadata(endpoint.metadata_json);
  const username = metadata.cc2_username || 'пользователь';
  await callTelegramApi(config, 'sendMessage', {
    chat_id: config.adminMirrorChatId,
    text: `⚠️ Telegram-привязка ${username} (chat ${endpoint.endpoint_id}) отключена: ${description}. ` +
          'Уведомления ему не доставляются — нужна новая привязка (tg_router.py invite).',
  }).catch(() => {});
}
