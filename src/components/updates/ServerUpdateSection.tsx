import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Loader2, MessageSquareText, RefreshCw, X, XCircle } from 'lucide-react';

import { useServerUpdates, type ServerUpdateApply, type ServerUpdatePending } from '../../hooks/useServerUpdates';
import { authenticatedFetch } from '../../utils/api';

/**
 * Плашка «Обновить» — пул изменений с другого сервера ждёт решения.
 *
 * Живёт внизу панели слева, над «Настройками»: место привычное по плашке
 * «Доступно обновление» сборки и заметное всегда, но не на пути. Нажатие
 * открывает окно со списком изменений и тремя решениями: применить, разобрать
 * в чате или отложить (пул остаётся в памяти сервера — его можно принять
 * позже просьбой в любом чате).
 *
 * Пока идёт установка, плашка превращается в индикатор: перезапуск службы
 * закончится перезагрузкой страницы сам (lib/appUpdate подхватит новую
 * сборку). Если сервер не настроен на обновления (нет apply-команды), секция
 * не рисуется совсем — на одиночных копиях элемента быть не должно.
 */

type Action = 'idle' | 'applying' | 'discussing' | 'dismissing';

/** Сколько клиент показывает спиннер, прежде чем предложить сброс. */
const CLIENT_APPLY_STALE_MS = 5 * 60_000;
/** Через сколько после ok/failed результат исчезает из плашки. */
const RESULT_DISMISS_MS = 15_000;

/** Прошедшее время с начала установки — тикает каждую секунду. */
function useElapsed(startedTs: number | undefined): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!startedTs) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [startedTs]);
  if (!startedTs) return '';
  const sec = Math.max(0, Math.round((now - startedTs) / 1_000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

function commitList(pending: ServerUpdatePending, limit: number) {
  const items = pending.commits.slice(0, limit);
  const rest = pending.commits.length - items.length;
  return { items, rest };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TFunc = (...args: any[]) => string;

/**
 * Плашка «Установка обновления…» — с таймером, прогрессом и кнопкой сброса.
 *
 * Раньше была просто спиннер + текст. Если скрипт выкатки зависал или не
 * закрывал apply.json, плашка висела бесконечно без возможности что-то сделать.
 * Теперь:
 * - показывает прошедшее время (человек видит, что что-то идёт)
 * - после CLIENT_APPLY_STALE_MS предлагает «Сбросить» (перечитает статус;
 *   сервер к тому времени уже мог пометить running → failed по таймауту)
 */
function ApplyingBanner({
  applying,
  onReset,
  t,
}: {
  applying: ServerUpdateApply | null;
  onReset: () => Promise<void>;
  t: TFunc;
}) {
  const elapsed = useElapsed(applying?.startedTs);
  const isStale = applying?.startedTs
    ? Date.now() - applying.startedTs > CLIENT_APPLY_STALE_MS
    : false;

  if (!applying) return null;
  return (
    <>
      <div className="nav-divider" />
      <div className="px-2 py-1.5 md:px-2 md:py-1.5">
        <div className="rounded-lg border border-blue-200/60 bg-blue-50/80 px-2.5 py-2 dark:border-blue-700/40 dark:bg-blue-900/15">
          <div className="flex items-center gap-2.5">
            <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-blue-500 dark:text-blue-400" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-blue-700 dark:text-blue-300">
              {t('serverUpdate.applying', 'Установка обновления…')}
            </span>
            {elapsed && (
              <span className="flex-shrink-0 tabular-nums text-[10px] text-blue-500/70 dark:text-blue-400/60">
                {elapsed}
              </span>
            )}
          </div>
          {isStale && (
            <button
              className="mt-1.5 w-full rounded-md border border-blue-300/50 py-1 text-[10px] font-medium text-blue-600 transition-colors hover:bg-blue-100/60 dark:border-blue-600/40 dark:text-blue-300 dark:hover:bg-blue-800/30"
              onClick={() => void onReset()}
            >
              {t('serverUpdate.resetStale', 'Долго — проверить статус')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Короткое уведомление о результате: «Обновлено» или «Не удалось».
 * Исчезает через RESULT_DISMISS_MS или по клику.
 */
function ResultBanner({
  result,
  onDismiss,
  t,
}: {
  result: ServerUpdateApply;
  onDismiss: () => void;
  t: TFunc;
}) {
  const ok = result.state === 'ok';
  return (
    <>
      <div className="nav-divider" />
      <div className="px-2 py-1.5 md:px-2 md:py-1.5">
        <button
          className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
            ok
              ? 'border-emerald-200/60 bg-emerald-50/80 hover:bg-emerald-100/60 dark:border-emerald-700/40 dark:bg-emerald-900/15'
              : 'border-red-200/60 bg-red-50/80 hover:bg-red-100/60 dark:border-red-700/40 dark:bg-red-900/15'
          }`}
          onClick={onDismiss}
          title={result.detail ?? ''}
        >
          {ok
            ? <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-500 dark:text-emerald-400" />
            : <XCircle className="h-4 w-4 flex-shrink-0 text-red-500 dark:text-red-400" />}
          <span className={`min-w-0 flex-1 truncate text-xs font-medium ${
            ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'
          }`}>
            {ok
              ? t('serverUpdate.resultOk', 'Обновлено')
              : t('serverUpdate.resultFailed', 'Не удалось обновить')}
          </span>
        </button>
      </div>
    </>
  );
}

export default function ServerUpdateSection() {
  const { t } = useTranslation(['sidebar', 'common']);
  const navigate = useNavigate();
  const { status, refresh } = useServerUpdates();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && action === 'idle') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [action]);

  const post = useCallback(
    async (path: string, body?: Record<string, unknown>) => {
      const response = await authenticatedFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const parsed = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(parsed?.error || `ошибка ${response.status}`);
      }
      return parsed?.data ?? {};
    },
    [],
  );

  const onApply = useCallback(
    async (force: boolean) => {
      if (!status.pending || action !== 'idle') return;
      setAction('applying');
      setError(null);
      try {
        await post('/api/updates/apply', { id: status.pending.id, force });
        setOpen(false);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'не удалось начать установку');
      } finally {
        setAction('idle');
      }
    },
    [action, post, refresh, status.pending],
  );

  const onDiscuss = useCallback(async () => {
    if (action !== 'idle') return;
    setAction('discussing');
    setError(null);
    try {
      const result = (await post('/api/updates/discuss')) as { sessionId?: string };
      setOpen(false);
      if (result.sessionId) navigate(`/session/${result.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'не удалось открыть чат');
    } finally {
      setAction('idle');
    }
  }, [action, navigate, post]);

  const onDismiss = useCallback(async () => {
    if (!status.pending || action !== 'idle') return;
    setAction('dismissing');
    setError(null);
    try {
      await post('/api/updates/dismiss', { id: status.pending.id });
      setOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'не удалось скрыть');
    } finally {
      setAction('idle');
    }
  }, [action, post, refresh, status.pending]);

  // Автоскрытие результата (ok/failed) через RESULT_DISMISS_MS
  const lastResult = status.lastResult;
  const [resultHidden, setResultHidden] = useState(false);
  const lastResultIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lastResult) { setResultHidden(false); lastResultIdRef.current = null; return; }
    if (lastResult.id !== lastResultIdRef.current) {
      lastResultIdRef.current = lastResult.id;
      setResultHidden(false);
    }
    const id = window.setTimeout(() => setResultHidden(true), RESULT_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [lastResult]);

  if (!status.configured) return null;

  const pending = status.pending;
  const applying = status.applying;

  return (
    <>
      <ApplyingBanner applying={applying} onReset={refresh} t={t} />

      {lastResult && !resultHidden && !applying && (
        <ResultBanner result={lastResult} onDismiss={() => setResultHidden(true)} t={t} />
      )}

      {pending && !applying && (
        <>
          <div className="nav-divider" />
          <div className="px-2 py-1.5 md:px-2 md:py-1.5">
            <button
              className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-emerald-50/80 dark:hover:bg-emerald-900/15"
              onClick={() => { setError(null); setOpen(true); }}
            >
              <div className="relative flex-shrink-0">
                <RefreshCw className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-normal text-emerald-700 dark:text-emerald-300">
                  {t('serverUpdate.plaque', 'Обновление · {{count}} изм.', { count: pending.commits.length })}
                </span>
                <span className="truncate text-[10px] text-emerald-600/70 dark:text-emerald-400/60">
                  {pending.conflict
                    ? t('serverUpdate.plaqueConflict', 'есть пересечение с вашими правками')
                    : pending.label}
                </span>
              </div>
            </button>
          </div>
        </>
      )}

      {status.dismissed && !pending && !applying && (
        <div className="px-2 pb-1 md:px-2">
          <button
            className="text-[10px] text-muted-foreground/70 underline-offset-2 hover:underline"
            onClick={async () => {
              try {
                await authenticatedFetch('/api/updates/dismiss', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ id: status.dismissed!.id, restore: true }),
                });
              } catch { /* недосыл — просто не откроем */ }
              await refresh();
            }}
            title={t('serverUpdate.dismissedHint', 'Обновление отложено — нажмите, чтобы вернуть плашку')}
          >
            {t('serverUpdate.dismissedLine', 'Есть отложенное обновление ({{count}} изм.)', { count: status.dismissed.commits })}
          </button>
        </div>
      )}

      {open && pending && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => { if (action === 'idle') setOpen(false); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="server-update-dialog-title"
            className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <RefreshCw className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="server-update-dialog-title" className="text-lg font-semibold text-foreground">
                  {t('serverUpdate.title', 'Обновление')}
                </h2>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{pending.label}</p>
              </div>
              <button
                className="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent"
                onClick={() => setOpen(false)}
                aria-label={t('actions.close', 'Закрыть')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {(() => {
              const { items, rest } = commitList(pending, 8);
              return (
                <ul className="mt-4 max-h-56 space-y-1.5 overflow-y-auto rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-[13px] leading-snug text-foreground">
                  {items.map((commit) => (
                    <li key={commit.sha} className="flex gap-2">
                      <code className="flex-shrink-0 text-[11px] text-muted-foreground">{commit.sha}</code>
                      <span className="min-w-0">{commit.subject}</span>
                    </li>
                  ))}
                  {rest > 0 && (
                    <li className="text-muted-foreground">{t('serverUpdate.moreCommits', '… и ещё {{count}}', { count: rest })}</li>
                  )}
                </ul>
              );
            })()}

            {pending.conflict && (
              <div className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50/80 px-3 py-2.5 dark:border-amber-700/40 dark:bg-amber-900/15">
                <div className="flex items-center gap-2 text-[13px] font-medium text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  {t('serverUpdate.conflictTitle', 'Пересечение с вашими правками')}
                </div>
                <ul className="mt-1.5 space-y-1 text-xs text-amber-800/90 dark:text-amber-300/80">
                  {pending.conflict.items.slice(0, 6).map((item) => (
                    <li key={item.path} className="break-words">{item.path}</li>
                  ))}
                  {(() => {
                    const total = pending.conflict!.total ?? pending.conflict!.items.length;
                    const rest = total - Math.min(6, pending.conflict!.items.length);
                    return rest > 0 ? (
                      <li className="text-amber-800/70 dark:text-amber-300/60">
                        {t('serverUpdate.moreConflicts', '… и ещё {{count}} мест', { count: rest })}
                      </li>
                    ) : null;
                  })()}
                </ul>
                <p className="mt-1.5 text-xs text-amber-800/80 dark:text-amber-300/70">
                  {t('serverUpdate.conflictNote', '«Обновить всё равно» заменит пересекающиеся правки новой версией. «Разобрать в чате» — агент разложит конфликт и предложит варианты.')}
                </p>
              </div>
            )}

            {error && (
              <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
            )}

            <div className="mt-5 space-y-2">
              {pending.conflict ? (
                <>
                  <button
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
                    disabled={action !== 'idle'}
                    onClick={() => void onDiscuss()}
                  >
                    {action === 'discussing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquareText className="h-4 w-4" />}
                    {t('serverUpdate.resolveInChat', 'Разобрать в чате')}
                  </button>
                  <button
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-amber-400/70 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-amber-900/20"
                    disabled={action !== 'idle'}
                    onClick={() => void onApply(true)}
                  >
                    {action === 'applying' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t('serverUpdate.applyAnyway', 'Обновить всё равно')}
                  </button>
                </>
              ) : (
                <button
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
                  disabled={action !== 'idle'}
                  onClick={() => void onApply(false)}
                >
                  {action === 'applying' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {t('serverUpdate.apply', 'Обновить')}
                </button>
              )}

              <div className="flex gap-2">
                {!pending.conflict && (
                  <button
                    className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl border border-border text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                    disabled={action !== 'idle'}
                    onClick={() => void onDiscuss()}
                  >
                    {action === 'discussing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquareText className="h-4 w-4" />}
                    {t('serverUpdate.discuss', 'Обсудить в чате')}
                  </button>
                )}
                <button
                  className="flex h-10 flex-1 items-center justify-center rounded-xl border border-border text-sm text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
                  disabled={action !== 'idle'}
                  onClick={() => void onDismiss()}
                >
                  {action === 'dismissing' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t('serverUpdate.dismiss', 'Отложить')}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
