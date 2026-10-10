import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw } from 'lucide-react';

import { authenticatedFetch } from '../../../../../../utils/api';
import { Badge, Button } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';

type DevinConnection = {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  health: string;
  cooldownUntil: string | null;
  lastError: string | null;
  boundSessions: number;
  hasCredentials: boolean;
  /** Ярлык в пикере аккаунтов (почта подписки или произвольный текст). */
  accountEmail: string | null;
};

type Task = {
  session_id: string;
  custom_name: string | null;
  initiator: string | null;
  updated_at: string;
};

const HEALTH_LABELS: Record<string, { text: string; className: string }> = {
  ok: { text: 'ok', className: 'bg-green-600 text-white' },
  auth_failed: { text: 'креда отозвана', className: 'bg-red-600 text-white' },
  rate_limited: { text: 'rate limit', className: 'bg-amber-500 text-white' },
  error: { text: 'сбой', className: 'bg-red-500/80 text-white' },
  unknown: { text: 'не проверен', className: 'bg-muted text-muted-foreground' },
};

/**
 * Platform-owner-only: управление корпоративными каналами Devin.
 * Самогейтование — GET /api/providers/devin/connections отвечает 403 любому
 * не-владельцу, секция просто не рендерится (как OwnerAccountSection).
 */
export default function DevinConnectionsSection() {
  const [connections, setConnections] = useState<DevinConnection[] | null>(null);
  const [tasks, setTasks] = useState<Record<number, Task[]>>({});
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState('0');
  const [showNewForm, setShowNewForm] = useState(false);
  const [credentialFor, setCredentialFor] = useState<number | null>(null);
  const [credentialText, setCredentialText] = useState('');
  const [labelFor, setLabelFor] = useState<number | null>(null);
  const [labelText, setLabelText] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/providers/devin/connections');
      if (!response.ok) {
        setConnections(null); // 403 — не владелец: секция скрывается
        return;
      }
      const body = await response.json();
      setConnections(body?.data?.connections ?? body?.connections ?? []);
    } catch {
      setConnections(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const call = useCallback(async (path: string, options: RequestInit = {}) => {
    setError(null);
    const response = await authenticatedFetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setError(body?.error?.message ?? `HTTP ${response.status}`);
      return null;
    }
    return response.json();
  }, []);

  if (connections === null) {
    return null;
  }

  const toggle = async (conn: DevinConnection) => {
    setBusy(conn.id);
    await call(`/api/providers/devin/connections/${conn.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !conn.enabled }),
    });
    await load();
    setBusy(null);
  };

  const healthCheck = async (conn: DevinConnection) => {
    setBusy(conn.id);
    await call(`/api/providers/devin/connections/${conn.id}/health`, { method: 'POST' });
    await load();
    setBusy(null);
  };

  const create = async () => {
    setBusy('new');
    const result = await call('/api/providers/devin/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: newName.trim(),
        description: newDescription.trim(),
        priority: Number(newPriority) || 0,
      }),
    });
    if (result) {
      setShowNewForm(false);
      setNewName(''); setNewDescription(''); setNewPriority('0');
    }
    await load();
    setBusy(null);
  };

  const installCredential = async (conn: DevinConnection) => {
    setBusy(conn.id);
    const result = await call(`/api/providers/devin/connections/${conn.id}/credential`, {
      method: 'POST',
      body: JSON.stringify({ credentialsToml: credentialText }),
    });
    if (result) {
      setCredentialFor(null);
      setCredentialText('');
    }
    await load();
    setBusy(null);
  };

  const saveLabel = async (conn: DevinConnection) => {
    setBusy(conn.id);
    await call(`/api/providers/devin/connections/${conn.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ accountEmail: labelText.trim() === '' ? null : labelText.trim() }),
    });
    setLabelFor(null);
    await load();
    setBusy(null);
  };

  const loadTasks = async (conn: DevinConnection) => {
    const result = await call(`/api/providers/devin/connections/${conn.id}/tasks`);
    if (result) {
      setTasks((prev) => ({ ...prev, [conn.id]: result?.data?.tasks ?? result?.tasks ?? [] }));
    }
  };

  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center gap-2">
        <Plug className="h-5 w-5" />
        <h3 className="text-lg font-semibold">Devin — корпоративные каналы</h3>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Серверные подключения, через которые пользователи запускают задачи Devin.
        Сотрудникам логиниться в Devin не нужно — канал выбирается сервером по
        приоритету, каждая задача привязана к веб-пользователю. Креда — файл
        credentials.toml, хранится на сервере (0600), в браузер не уходит.
      </p>

      {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

      <div className="space-y-3">
        {connections.map((conn) => {
          const health = HEALTH_LABELS[conn.health] ?? HEALTH_LABELS.unknown;
          const isBusy = busy === conn.id;
          return (
            <SettingsCard key={conn.id} className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{conn.name}</span>
                    <Badge className={`shrink-0 ${health.className}`}>{health.text}</Badge>
                    {!conn.enabled && <Badge className="shrink-0 bg-muted">выключен</Badge>}
                    {conn.cooldownUntil && <Badge className="shrink-0 bg-amber-600 text-white">cooldown</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    приоритет {conn.priority} · чатов {conn.boundSessions}
                    {conn.hasCredentials ? '' : ' · креды нет'}
                    {conn.accountEmail ? ` · ярлык: ${conn.accountEmail}` : ''}
                    {conn.description ? ` · ${conn.description}` : ''}
                  </div>
                  {conn.lastError && (
                    <div className="mt-1 truncate text-xs text-red-500/80" title={conn.lastError}>
                      {conn.lastError}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="outline" disabled={isBusy} onClick={() => void healthCheck(conn)}>
                    <RefreshCw className="mr-1 h-3 w-3" />Health
                  </Button>
                  <Button size="sm" variant="outline" disabled={isBusy} onClick={() => void toggle(conn)}>
                    {conn.enabled ? 'Выключить' : 'Включить'}
                  </Button>
                  <Button size="sm" variant="outline" disabled={isBusy}
                    onClick={() => setCredentialFor(credentialFor === conn.id ? null : conn.id)}>
                    Креда
                  </Button>
                  <Button size="sm" variant="outline" disabled={isBusy}
                    onClick={() => {
                      setLabelFor(labelFor === conn.id ? null : conn.id);
                      setLabelText(conn.accountEmail ?? '');
                    }}>
                    Ярлык
                  </Button>
                  <Button size="sm" variant="outline" disabled={isBusy} onClick={() => void loadTasks(conn)}>
                    Задачи
                  </Button>
                </div>
              </div>

              {labelFor === conn.id && (
                <div className="mt-3 space-y-2">
                  <input
                    className="w-full rounded-md border bg-background p-2 text-sm"
                    placeholder="Ярлык в пикере аккаунтов (напр. devin-pro-1 или почта)"
                    value={labelText}
                    onChange={(e) => setLabelText(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={isBusy} onClick={() => void saveLabel(conn)}>
                      Сохранить
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setLabelFor(null)}>
                      Отмена
                    </Button>
                  </div>
                </div>
              )}

              {credentialFor === conn.id && (
                <div className="mt-3 space-y-2">
                  <textarea
                    className="w-full rounded-md border bg-background p-2 font-mono text-xs"
                    rows={6}
                    placeholder={'windsurf_api_key = "..."\napi_server_url = "..."\ndevin_webapp_host = "..."\ndevin_api_url = "..."'}
                    value={credentialText}
                    onChange={(e) => setCredentialText(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={isBusy || !credentialText.trim()} onClick={() => void installCredential(conn)}>
                      Установить и проверить
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setCredentialFor(null); setCredentialText(''); }}>
                      Отмена
                    </Button>
                  </div>
                </div>
              )}

              {tasks[conn.id] && (
                <div className="mt-3 space-y-1 border-t pt-2">
                  {tasks[conn.id].length === 0 && (
                    <div className="text-xs text-muted-foreground">Чатов через канал нет.</div>
                  )}
                  {tasks[conn.id].map((task) => (
                    <div key={task.session_id} className="flex justify-between text-xs">
                      <span className="truncate">{task.custom_name ?? task.session_id.slice(0, 8)}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {task.initiator ?? '—'} · {task.updated_at?.slice(0, 16).replace('T', ' ')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </SettingsCard>
          );
        })}
      </div>

      {showNewForm ? (
        <SettingsCard className="mt-3 p-4">
          <div className="space-y-2">
            <input className="w-full rounded-md border bg-background p-2 text-sm" placeholder="name (e.g. prod-eu)"
              value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input className="w-full rounded-md border bg-background p-2 text-sm" placeholder="Назначение (опционально)"
              value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
            <input className="w-full rounded-md border bg-background p-2 text-sm" placeholder="Приоритет (0 — первый)"
              value={newPriority} onChange={(e) => setNewPriority(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === 'new' || !newName.trim()} onClick={() => void create()}>Создать</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowNewForm(false)}>Отмена</Button>
            </div>
          </div>
        </SettingsCard>
      ) : (
        <Button className="mt-3" size="sm" variant="outline" onClick={() => setShowNewForm(true)}>
          Добавить канал
        </Button>
      )}
    </div>
  );
}
