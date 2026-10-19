import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import {
  classifyFormatDomain,
  extractFormatFingerprint,
  formatFingerprintHash,
} from '../../../../utils/formatFingerprint';

/**
 * Оценка формата ответа ассистента — «палец вверх / палец вниз».
 *
 * Контракт перенесён из референса ~/response-format-memory (Егор 19.10.26):
 * PUT /api/messages/{message_id}/feedback идемпотентен — повторное нажатие
 * переписывает ту же строку (ответ несёт revision). Дизлайк сначала спрашивает
 * причину и необязательный комментарий (до 2000 символов), лайк уходит сразу.
 *
 * Вместе с направлением клиент считает по тексту ответа domain и format_hash —
 * в боевой базе сообщений нет, поэтому эти поля денормализуются в запись
 * оценки (см. server/modules/message-feedback).
 *
 * Состояние «оценено» переживает перезагрузку: при монтировании контрол
 * присоединяется к общему чтению оценок сессии (одна выборка на сессию для
 * всех сообщений ленты).
 */

type StoredFeedback = {
  direction: 'like' | 'dislike';
  category: string | null;
};

const DISLIKE_CATEGORIES = [
  'too_long',
  'too_short',
  'wrong_structure',
  'missing_table',
  'too_verbose',
  'unclear',
  'custom',
] as const;

type DislikeCategory = (typeof DISLIKE_CATEGORIES)[number];

const MAX_COMMENT_LENGTH = 2000;
const SAVED_FLASH_MS = 2500;

// Одна выборка оценок на сессию для всех контролов ленты: Map<messageId, feedback>.
const sessionFeedbackRequests = new Map<string, Promise<Map<string, StoredFeedback>>>();

function loadSessionFeedback(sessionId: string): Promise<Map<string, StoredFeedback>> {
  let pending = sessionFeedbackRequests.get(sessionId);
  if (!pending) {
    pending = authenticatedFetch(
      `/api/messages/feedback?sessionId=${encodeURIComponent(sessionId)}`
    )
      .then(async (response) => {
        const map = new Map<string, StoredFeedback>();
        if (!response.ok) return map;
        const payload = await response.json().catch(() => null);
        for (const item of payload?.items ?? []) {
          if (item?.message_id && (item.direction === 'like' || item.direction === 'dislike')) {
            map.set(item.message_id, { direction: item.direction, category: item.category ?? null });
          }
        }
        return map;
      })
      .catch(() => {
        // Промах кэша не запоминаем: иначе упавший при рестарте сервера запрос
        // навсегда оставлял бы кнопки «не оценёнными» до перезагрузки страницы.
        sessionFeedbackRequests.delete(sessionId);
        return new Map<string, StoredFeedback>();
      });
    sessionFeedbackRequests.set(sessionId, pending);
  }
  return pending;
}

async function sendFeedback(
  messageId: string,
  body: Record<string, unknown>
): Promise<boolean> {
  const response = await authenticatedFetch(
    `/api/messages/${encodeURIComponent(messageId)}/feedback`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return response.ok;
}

async function deleteFeedback(messageId: string): Promise<boolean> {
  const response = await authenticatedFetch(
    `/api/messages/${encodeURIComponent(messageId)}/feedback`,
    { method: 'DELETE' }
  );
  return response.ok;
}

async function formatExtras(content: string): Promise<Record<string, unknown>> {
  try {
    const fingerprint = extractFormatFingerprint(content);
    return {
      domain: classifyFormatDomain(content),
      format_hash: await formatFingerprintHash(fingerprint),
    };
  } catch {
    // hash недоступен (редко: нет crypto.subtle) — оценка важнее снапшота формы.
    return { domain: classifyFormatDomain(content) };
  }
}

export default function MessageFeedbackControl({
  messageId,
  sessionId,
  content,
}: {
  messageId: string;
  sessionId?: string | null;
  content: string;
}) {
  const { t } = useTranslation('chat');
  const [selected, setSelected] = useState<'like' | 'dislike' | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [category, setCategory] = useState<DislikeCategory>('unclear');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState<'saved' | 'cleared' | false>(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionMapRef = useRef<Map<string, StoredFeedback> | null>(null);

  // Восстановление нажатого состояния после перезагрузки страницы.
  useEffect(() => {
    setSelected(null);
    if (!sessionId) return;
    let alive = true;
    void loadSessionFeedback(sessionId).then((map) => {
      if (!alive) return;
      sessionMapRef.current = map;
      const stored = map.get(messageId);
      if (stored) setSelected(stored.direction);
    });
    return () => {
      alive = false;
    };
  }, [messageId, sessionId]);

  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    []
  );

  const flashSaved = useCallback((kind: 'saved' | 'cleared' = 'saved') => {
    setSavedFlash(kind);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSavedFlash(false), SAVED_FLASH_MS);
  }, []);

  const applyVote = useCallback(
    (direction: 'like' | 'dislike', stored: StoredFeedback) => {
      setSelected(direction);
      sessionMapRef.current?.set(messageId, stored);
      flashSaved();
    },
    [messageId, flashSaved]
  );

  const clearVote = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await deleteFeedback(messageId);
      if (ok) {
        setSelected(null);
        sessionMapRef.current?.delete(messageId);
        flashSaved('cleared');
      } else {
        setError(t('feedback.saveError', { defaultValue: 'Не удалось сохранить оценку' }));
      }
    } catch {
      setError(t('feedback.saveError', { defaultValue: 'Не удалось сохранить оценку' }));
    } finally {
      setBusy(false);
    }
  }, [busy, messageId, flashSaved, t]);

  const voteLike = useCallback(async () => {
    if (busy) return;
    // Повторный клик на активный лайк — отмена оценки.
    if (selected === 'like') return clearVote();
    setBusy(true);
    setError(null);
    try {
      const extras = await formatExtras(content);
      const ok = await sendFeedback(messageId, {
        direction: 'like',
        sessionId: sessionId ?? undefined,
        ...extras,
      });
      if (ok) {
        applyVote('like', { direction: 'like', category: null });
      } else {
        setError(t('feedback.saveError', { defaultValue: 'Не удалось сохранить оценку' }));
      }
    } catch {
      setError(t('feedback.saveError', { defaultValue: 'Не удалось сохранить оценку' }));
    } finally {
      setBusy(false);
    }
  }, [busy, selected, content, messageId, sessionId, applyVote, clearVote, t]);

  const saveDislike = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const extras = await formatExtras(content);
      const ok = await sendFeedback(messageId, {
        direction: 'dislike',
        category,
        comment: comment.trim() || undefined,
        sessionId: sessionId ?? undefined,
        ...extras,
      });
      if (ok) {
        applyVote('dislike', { direction: 'dislike', category });
        setDialogOpen(false);
        setComment('');
      } else {
        setError(t('feedback.saveError', { defaultValue: 'Не удалось сохранить оценку' }));
      }
    } catch {
      setError(t('feedback.saveError', { defaultValue: 'Не удалось сохранить оценку' }));
    } finally {
      setBusy(false);
    }
  }, [busy, content, messageId, sessionId, category, comment, applyVote, t]);

  // Тот же вид, что у соседних контролов: маленькие ghost-кнопки в строке под ответом.
  const buttonBase =
    'inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-gray-200 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-gray-700 dark:hover:text-gray-300 disabled:opacity-50';
  const idleColor = 'text-gray-400 dark:text-gray-500';
  const activeColor = 'text-primary dark:text-primary';

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={`${buttonBase} ${selected === 'like' ? activeColor : idleColor}`}
        aria-label={t('feedback.like', { defaultValue: 'Формат ответа удобен' })}
        aria-pressed={selected === 'like'}
        title={t('feedback.like', { defaultValue: 'Формат ответа удобен' })}
        disabled={busy}
        onClick={voteLike}
      >
        <ThumbsUp className="h-3.5 w-3.5" fill={selected === 'like' ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        className={`${buttonBase} ${selected === 'dislike' ? activeColor : idleColor}`}
        aria-label={t('feedback.dislike', { defaultValue: 'Формат ответа неудобен' })}
        aria-pressed={selected === 'dislike'}
        title={t('feedback.dislike', { defaultValue: 'Формат ответа неудобен' })}
        disabled={busy}
        onClick={() => (selected === 'dislike' ? clearVote() : setDialogOpen(true))}
      >
        <ThumbsDown className="h-3.5 w-3.5" fill={selected === 'dislike' ? 'currentColor' : 'none'} />
      </button>
      {savedFlash && (
        <span className="ml-1 whitespace-nowrap text-gray-400 dark:text-gray-500">
          {savedFlash === 'cleared'
            ? t('feedback.cleared', { defaultValue: 'Оценка снята' })
            : t('feedback.saved', { defaultValue: 'Оценка сохранена' })}
        </span>
      )}
      {error && !dialogOpen && (
        <span className="ml-1 whitespace-nowrap text-red-500">{error}</span>
      )}

      {dialogOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={() => {
              if (!busy) setDialogOpen(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="feedback-dialog-title"
              className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 id="feedback-dialog-title" className="text-lg font-semibold text-foreground">
                {t('feedback.dialogTitle', { defaultValue: 'Что было неудобно в формате?' })}
              </h2>

              <div className="mt-4 flex flex-wrap gap-2">
                {DISLIKE_CATEGORIES.map((value) => (
                  <label
                    key={value}
                    className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm transition-colors ${
                      category === value
                        ? 'border-primary bg-primary/15 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <input
                      type="radio"
                      name="feedback-category"
                      value={value}
                      checked={category === value}
                      onChange={() => setCategory(value)}
                      className="sr-only"
                    />
                    {t(`feedback.categories.${value}`, { defaultValue: value })}
                  </label>
                ))}
              </div>

              <div className="mt-4">
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value.slice(0, MAX_COMMENT_LENGTH))}
                  rows={3}
                  maxLength={MAX_COMMENT_LENGTH}
                  placeholder={t('feedback.commentPlaceholder', {
                    defaultValue: 'Комментарий, если нужно',
                  })}
                  className="w-full resize-none rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
                />
                <div className="mt-1 text-right text-xs text-muted-foreground">
                  {comment.length}/{MAX_COMMENT_LENGTH}
                </div>
              </div>

              {error && (
                <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>
              )}

              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDialogOpen(false)}
                  className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {t('feedback.cancel', { defaultValue: 'Отмена' })}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={saveDislike}
                  className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {t('feedback.save', { defaultValue: 'Сохранить' })}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
