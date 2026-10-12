// @ts-expect-error -- у web-push нет объявлений типов (та же ситуация в vapid-keys.service.ts)
import webPushModule from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopNotification as sendDesktopNotificationToClients } from '@/modules/notifications/services/desktop-notification-clients.service.js';
import { sendTelegramNotification } from '@/modules/notifications/services/telegram-notification.service.js';

const webPush = webPushModule as {
  sendNotification(subscription: unknown, payload: string): Promise<unknown>;
};

type NotificationKind = 'action_required' | 'stop' | 'error' | 'info' | string;
type NotificationSeverity = 'info' | 'error' | string;

export type NotificationEvent = {
  provider: string;
  sessionId: string | null;
  kind: NotificationKind;
  code: string;
  meta: Record<string, unknown>;
  severity: NotificationSeverity;
  requiresUserAction: boolean;
  dedupeKey: string | null;
  createdAt: string;
};

export type NotificationPayload = {
  title: string;
  body: string;
  data: {
    sessionId: string | null;
    code: string;
    provider: string | null;
    sessionName: string | null;
    tag: string;
  };
};

type NotificationPreferences = {
  channels?: Record<string, boolean>;
  events?: { actionRequired?: boolean; stop?: boolean; error?: boolean };
};

type NotificationChannel = {
  id: string;
  isEnabled: (preferences: NotificationPreferences | null | undefined) => boolean;
  send: (input: { userId: number; event: NotificationEvent; payload: NotificationPayload }) => unknown;
};

const KIND_TO_PREF_KEY: Record<string, 'actionRequired' | 'stop' | 'error'> = {
  action_required: 'actionRequired',
  stop: 'stop',
  error: 'error'
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  system: 'System'
};

const recentEventKeys = new Map<string, number>();
const DEDUPE_WINDOW_MS = 20000;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isNotificationEventEnabled(preferences: NotificationPreferences | null | undefined, event: NotificationEvent): boolean {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind];
  const eventEnabled = prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;

  return eventEnabled;
}

function isDuplicate(event: NotificationEvent): boolean {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false
}: {
  provider: string;
  sessionId?: string | null;
  kind?: NotificationKind;
  code?: string;
  meta?: Record<string, unknown>;
  severity?: NotificationSeverity;
  dedupeKey?: string | null;
  requiresUserAction?: boolean;
}): NotificationEvent {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName: unknown): string | null {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(row: { provider?: string } | null | undefined, provider: string | undefined): boolean {
  return Boolean(row) && (!provider || row!.provider === provider);
}

function resolveSessionRow(sessionId: string | null, provider: string | undefined) {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId);
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

// Часть вызывающих (Settings, тесты) передаёт событие не целиком — поля
// подхватываются значениями по умолчанию, как это было в JS-версии.
type NotificationEventInput = Partial<NotificationEvent>;

function normalizeNotificationSession<T extends NotificationEventInput>(event: T): T {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  };
}

function resolveSessionName(event: NotificationEventInput): string | null {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

function buildNotificationPayload(event: NotificationEventInput): NotificationPayload {
  const normalizedEvent = normalizeNotificationSession(event);
  const meta = normalizedEvent.meta || {};
  const CODE_MAP: Record<string, string> = {
    'permission.required': meta.toolName
      ? `Action Required: Tool "${meta.toolName}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': (meta.stopReason as string) || 'Run Stopped: The run has stopped',
    'run.background_completed': 'Background work finished',
    'run.failed': meta.error ? `Run Failed: ${meta.error}` : 'Run Failed: The run encountered an error',
    'agent.notification': meta.message ? String(meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  const providerLabel = (normalizedEvent.provider && PROVIDER_LABELS[normalizedEvent.provider]) || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const message = (normalizedEvent.code && CODE_MAP[normalizedEvent.code]) || 'You have a new notification';

  return {
    title: sessionName || 'CloudCLI',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code || 'generic.info',
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

function sendWebPushPayload(userId: number, payload: NotificationPayload): Promise<void> {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return Promise.resolve();

  const serializedPayload = JSON.stringify(payload);
  return Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        },
        serializedPayload
      )
    )
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = (result.reason as { statusCode?: number })?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
        }
      }
    });
  });
}

const notificationChannels: NotificationChannel[] = [
  {
    id: 'webPush',
    // TODO: Web push still uses push_subscriptions. Do not remove that table until
    // browser push subscriptions are migrated into notification_channel_endpoints.
    isEnabled: (preferences) => Boolean(preferences?.channels?.webPush),
    send: ({ userId, payload }) => sendWebPushPayload(userId, payload)
  },
  {
    id: 'desktop',
    isEnabled: (preferences) => Boolean(preferences?.channels?.desktop),
    send: ({ userId, payload }) => sendDesktopNotificationToClients(userId, payload)
  },
  {
    // Telegram-канал: адресаты — notification_channel_endpoints (channel='telegram'),
    // привязка через одноразовый код в боте + ~/scripts/tg_router.py.
    id: 'telegram',
    isEnabled: (preferences) => Boolean(preferences?.channels?.telegram),
    send: ({ userId, payload }) => sendTelegramNotification({ userId, payload })
  }
];

function notifyUserIfEnabled({ userId, event }: { userId: number | null | undefined; event: unknown }): void {
  if (!userId || !event || typeof event !== 'object') {
    return;
  }

  const normalizedEvent = normalizeNotificationSession(event as NotificationEvent);
  const preferences = notificationPreferencesDb.getPreferences(userId);
  if (!isNotificationEventEnabled(preferences, normalizedEvent)) {
    return;
  }
  if (isDuplicate(normalizedEvent)) {
    return;
  }

  const payload = buildNotificationPayload(normalizedEvent);
  for (const channel of notificationChannels) {
    if (!channel.isEnabled(preferences)) {
      continue;
    }
    Promise.resolve(channel.send({ userId, event: normalizedEvent, payload })).catch((err) => {
      console.error(`Notification channel "${channel.id}" send error:`, err);
    });
  }
}

function notifyRunStopped({ userId, provider, sessionId = null, stopReason = 'completed', sessionName = null }: {
  userId: number | null | undefined;
  provider: string;
  sessionId?: string | null;
  stopReason?: string;
  sessionName?: string | null;
}): void {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`
    })
  });
}

/**
 * Reports background work that finished after its turn had already completed.
 *
 * Uses the `stop` kind so it rides the existing "run stopped" preference rather
 * than needing a new opt-in that would default to off. No explicit dedupeKey, so
 * the default composite key collapses repeats inside the dedupe window.
 */
function notifyBackgroundWorkCompleted({ userId, provider, sessionId = null, sessionName = null }: {
  userId: number | null | undefined;
  provider: string;
  sessionId?: string | null;
  sessionName?: string | null;
}): void {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.background_completed',
      meta: { sessionName },
      severity: 'info'
    })
  });
}

function notifyRunFailed({ userId, provider, sessionId = null, error, sessionName = null }: {
  userId: number | null | undefined;
  provider: string;
  sessionId?: string | null;
  error: unknown;
  sessionName?: string | null;
}): void {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`
    })
  });
}

export {
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
  notifyRunStopped,
  notifyRunFailed,
  notifyBackgroundWorkCompleted
};
