import path from 'node:path';

import { chatGroupsDb, chatMessageQueueDb, chatRunsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { isRecordedAgentAlive, isSurvivorRunning, listSurvivors } from '@/modules/providers/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastRealtimeEvent } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 * - `promptAnchored`: true once the user prompt has been handed to a process
 *   that survives a web server restart (Devin supervisor saw session/prompt,
 *   Codex worker launched, Claude CLI produced its first event). Until then
 *   the run is only bootstrap — a restart kills it together with the accepted
 *   user message, which is how a fresh chat could end up permanently empty
 *   (13.10.26: deploy restarted the site 20 s into a Devin session/new, the
 *   prompt was never sent, the chat opened empty forever).
 * - `pendingMessage`: the accepted user message kept while the run is
 *   unanchored, so the shutdown path can push it back onto the durable chat
 *   queue instead of losing it.
 */
type ChatRun = {
  /** Номер строки в журнале chat_runs — терминальный исход переживает процесс. */
  runId: string;
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
  promptAnchored: boolean;
  pendingMessage: PendingUserMessage | null;
  /** Момент последнего живого события хода — по нему сторож отличает «долго думает» от «умер молча». */
  lastActivityAt: number;
  /** Причина терминального неуспеха — в журнал и в плашку человеку. */
  lastErrorText: string | null;
  /** О «давно без вывода» уже сказали — повторять раз в обход нельзя. */
  stallNotified: boolean;
};

/** Message accepted from a user, remembered until the provider has it. */
type PendingUserMessage = {
  id: string;
  userId: string | null;
  content: string;
  options: Record<string, unknown>;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Сколько незаякоренный ход ещё держит перезапуск. Сборка хода в норме —
 * секунды (spawn + рукопожатие + session/new у Devin ~15–20 с); вышедший за
 * предел ход считается зависшим: перезапуск больше не ждёт, а сообщение
 * уходит в очередь при гашении (requeueUnanchoredRuns).
 */
const PROMPT_ANCHOR_GRACE_MS = 120_000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

/**
 * A deliberate server restart first closes this gate. Claude, Codex and Devin
 * own survivable processes and continue across the restart; any provider
 * without that capability is allowed to finish before the web process exits.
 */
let acceptingNewRuns = true;

/**
 * Ожидание перед выкладкой (SIGUSR2 от deploy/build-shared.sh) — аренда, а не
 * выключатель. 04.10.26 скрипт выкладки оборвался вместе со своим чатом через
 * 5 минут ожидания, а вход остался закрытым: 33 минуты все сообщения Егора во
 * всех чатах молча ложились в очередь, пока сайт не перезапустили руками.
 * Теперь скрипт продлевает аренду на каждом шаге ожидания; перестал — через
 * PRE_RESTART_LEASE_MS вход открывается сам, очередь уходит обходом раз в минуту.
 *
 * И закрывает она только неживучих провайдеров: Claude, Codex и Devin
 * переживают перезапуск сами, держать их чаты ради чужого неживучего незачем.
 */
const PRE_RESTART_LEASE_MS = 120_000;
let preRestartDrainUntil = 0;

function isRestartSafeProvider(provider: string): boolean {
  // У Devin ход переживает перезапуск так же, как у Codex: ACP-процесс держит
  // devin-acp-supervisor, а после рестарта рантайм переподключается к сокету
  // (survivor-runs знает devin отдельно). Иначе выкладка ждала бы каждый ход
  // Devin до конца — а они длятся десятки минут.
  return provider === 'claude' || provider === 'codex' || provider === 'devin';
}

function isPreRestartDrainActive(): boolean {
  if (preRestartDrainUntil === 0) {
    return false;
  }
  if (Date.now() < preRestartDrainUntil) {
    return true;
  }
  preRestartDrainUntil = 0;
  console.log('[shutdown-drain] выкладка перестала продлевать ожидание — вход новым ходам снова открыт');
  return false;
}

async function broadcastCanonicalSessionUpsert(appSessionId: string): Promise<void> {
  let row = sessionsDb.getSessionById(appSessionId);
  if (!row || row.isArchived) {
    return;
  }

  // Чаты, начатые с сайта, сообщают о себе отсюда, а не через наблюдателя за
  // файлами. Без подбора здесь новый чат со словом «SunSchool» в названии
  // оставался без группы — проверено на живом сайте 13.09.26.
  try {
    if (chatGroupsDb.autoAssignSession(row.session_id)) {
      row = sessionsDb.getSessionById(appSessionId) ?? row;
    }
  } catch (error) {
    console.error('[chat-groups] подбор группы не удался:', error);
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
      groupId: row.group_id ?? null,
      groupLabel: row.group_label ?? null,
      // Блок верхней панели: без него живое обновление вернуло бы
      // перенесённый чат в «Проекты» до перезагрузки страницы.
      serverScope: row.server_scope ?? null,
      flagged: Boolean(row.is_flagged),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
        serverScope: project.server_scope ?? 'main',
      }
      : null,
    timestamp: new Date().toISOString(),
  });

  broadcastRealtimeEvent(payload, row.provider);
}

function evictRunLater(appSessionId: string): void {
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;
  run.lastActivityAt = Date.now();

  // Последний текст ошибки хода — причина для журнала и плашки, если ход
  // оборвётся. mid-run «error» без complete не финален: статус останется
  // 'completed', и записанная причина просто не покажется.
  if (message.kind === 'error' && typeof message.content === 'string' && message.content.trim()) {
    run.lastErrorText = message.content.slice(0, 2000);
  }

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
    runStartedAt: run.startedAt,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    persistRunOutcome(run, outbound);
    evictRunLater(run.appSessionId);
    notifyRunCompleted(run.appSessionId);
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Слушатели конца хода.
 *
 * Пока их не было, «ход закончился» знала только страница — и очередь
 * следующих сообщений отправлял браузер. Теперь по этому сигналу сервер сам
 * снимает с очереди следующее сообщение чата (chat-queue.service), поэтому он
 * нужен здесь, в единственном месте, где ход становится завершённым.
 */
const runCompletionListeners = new Set<(appSessionId: string) => void>();

/**
 * Терминальный исход хода: в журнал chat_runs (переживает перезапуск и
 * смерть процесса) и рассылкой `run_terminal` — чтобы его видели ВСЕ
 * вкладки, а не только та, чей сокет держал поток. 14.10.26 ход умер на
 * лимите модели, событие ушло в уже убитую iOS-страницу, и человек
 * полтора часа смотрел на замершую ленту без единого знака конца.
 */
function persistRunOutcome(run: ChatRun, completeEvent: NormalizedMessage): void {
  const status =
    completeEvent.aborted === true
      ? 'aborted'
      : completeEvent.success === false || (typeof completeEvent.exitCode === 'number' && completeEvent.exitCode !== 0)
        ? 'failed'
        : 'completed';
  try {
    chatRunsDb.finish(run.runId, { status, error: run.lastErrorText });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] исход хода не записался в журнал', { appSessionId: run.appSessionId, error: message });
  }
  try {
    broadcastRealtimeEvent(JSON.stringify({
      kind: 'run_terminal',
      sessionId: run.appSessionId,
      provider: run.provider,
      status,
      error: run.lastErrorText,
      finishedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    }), run.provider);
  } catch {
    // рассылка не удалась — запись в журнале уже есть, подписка её найдёт
  }
}

/** Подписка на конец хода. Используется websocket-модулем при поднятии сервера. */
export function onChatRunCompleted(listener: (appSessionId: string) => void): void {
  runCompletionListeners.add(listener);
}

function notifyRunCompleted(appSessionId: string): void {
  for (const listener of runCompletionListeners) {
    try {
      listener(appSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Run completion listener failed', { appSessionId, error: message });
    }
  }
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    connection: RealtimeClientConnection;
    userId: string | number | null;
    pendingMessage?: PendingUserMessage;
  }): ChatRun | null {
    if (!acceptingNewRuns) {
      return null;
    }
    if (!isRestartSafeProvider(input.provider) && isPreRestartDrainActive()) {
      return null;
    }
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }
    // Агент прошлого сервера ещё дописывает этот чат: второй процесс на ту же
    // переписку испортил бы её, поэтому новое сообщение ждёт.
    if (isSurvivorRunning(input.appSessionId)) {
      return null;
    }

    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const run: ChatRun = {
      runId,
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
      promptAnchored: false,
      pendingMessage: input.pendingMessage ?? null,
      lastActivityAt: Date.now(),
      lastErrorText: null,
      stallNotified: false,
    };

    // Ход пишется на диск ДО старта: процесс, умерший посреди сборки,
    // оставляет строку «running» — сверка при подъёме закроет её с причиной
    // и вернёт сообщение в очередь, а не оставит чат мёртвым навсегда.
    try {
      chatRunsDb.begin({
        runId,
        sessionId: input.appSessionId,
        provider: input.provider,
        pending: run.pendingMessage
          ? {
            id: run.pendingMessage.id,
            userId: run.pendingMessage.userId,
            content: run.pendingMessage.content,
            options: run.pendingMessage.options,
          }
          : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] старт хода не записался в журнал', { appSessionId: input.appSessionId, error: message });
    }

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);
    return run;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running' || isSurvivorRunning(appSessionId);
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
    promptAnchored: boolean;
  }> {
    const live = Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
        promptAnchored: run.promptAnchored,
      }));
    const liveIds = new Set(live.map((run) => run.sessionId));
    // Агент прошлого сервера — по определению заякорен: его процесс уже
    // держит ход, иначе супервизор убрал бы его ещё до нашего подъёма.
    const survivors = listSurvivors()
      .filter((run) => !liveIds.has(run.sessionId))
      .map((run) => ({ ...run, promptAnchored: true }));
    return [...live, ...survivors] as typeof live;
  },

  /**
   * Заякорить ход: prompt ушёл выживающему процессу, перезапуск сайта ход
   * больше не рвёт. Вызывают рантаймы провайдеров в точке передачи prompt;
   * сверка по объекту хода — протухший вызов уже сменившегося хода не бьёт
   * по новому.
   */
  markRunPromptAnchored(run: ChatRun): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }
    run.promptAnchored = true;
    try {
      chatRunsDb.markAnchored(run.runId);
    } catch {
      // журнал не написался — работа хода это не роняет
    }
    // Сообщение подтверждённо у агента — строка очереди (захваченная обходом
    // или write-ahead прямой отправки) снимается здесь и только здесь:
    // до этого момента её держала база, не память хода.
    const pending = run.pendingMessage;
    if (pending) {
      run.pendingMessage = null;
      try {
        chatMessageQueueDb.markDelivered(pending.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Chat] якорь хода ${run.appSessionId}: не удалось снять сообщение ${pending.id} с очереди: ${message}`);
      }
    }
  },

  /**
   * Ходы, которым перезапуск сайта ещё опасен. Неживучий провайдер мешает до
   * конца хода, живучий — только пока не заякорен: процесс-держатель уже
   * поднят, но prompt ему ещё не записан, и смерть сервера сейчас убьёт и
   * агента, и сообщение человека.
   *
   * Щит незаякоренного хода ограничен по времени: если сборка зависла
   * (например, чат держит замок другой Devin-процесс), сообщение спасает
   * возврат в очередь при гашении, а выкладка не встаёт навсегда.
   */
  listRestartBlockingRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
    promptAnchored: boolean;
  }> {
    return this.listRunningRuns().filter((run) =>
      !isRestartSafeProvider(run.provider)
      || (!run.promptAnchored && Date.now() - run.startedAt < PROMPT_ANCHOR_GRACE_MS));
  },

  /**
   * Возвращает в серверную очередь сообщения ходов, до агента не доехавшие.
   * Зовётся на гашении процесса (SIGTERM/SIGINT) — синхронной записью в базу:
   * после подъёма обход очередей отправит их заново. Заякоренные ходы не
   * трогаем — их сообщения уже у выживающего процесса.
   */
  requeueUnanchoredRuns(): number {
    let requeued = 0;
    for (const run of runs.values()) {
      if (run.status !== 'running' || run.promptAnchored || !run.pendingMessage) {
        continue;
      }
      const pending = run.pendingMessage;
      run.pendingMessage = null;
      try {
        chatRunsDb.clearPending(run.runId);
      } catch {
        // журнал подчистится сверкой при подъёме
      }
      try {
        // Строка захвачена этим ходом и уже лежит в базе — просто снимаем
        // захват, она уйдёт обходом после подъёма. Гашение — не неудача
        // доставки, счётчик попыток не трогаем. Строки нет в базе (write-ahead
        // не записался) — вставляем как новую в начало.
        if (chatMessageQueueDb.has(pending.id)) {
          chatMessageQueueDb.releaseClaim(pending.id);
        } else {
          chatMessageQueueDb.insertFront({
            id: pending.id,
            sessionId: run.appSessionId,
            userId: pending.userId,
            content: pending.content,
            options: pending.options,
            createdAt: new Date().toISOString(),
          });
        }
        requeued += 1;
        console.warn(
          `[shutdown-drain] сообщение ${pending.id} чата ${run.appSessionId} не дошло до агента — вернул в очередь, уйдёт после подъёма`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[shutdown-drain] не удалось вернуть сообщение ${pending.id} чата ${run.appSessionId} в очередь: ${message}`,
        );
      }
    }
    return requeued;
  },

  /**
   * Stops new provider runs before a graceful server restart. The websocket
   * handler interprets a rejected start as "queue this message", so nothing
   * typed while the deployment is draining is lost.
   *
   * Consumed by the server entrypoint's SIGTERM/SIGINT shutdown path.
   */
  beginShutdownDrain(): void {
    acceptingNewRuns = false;
  },

  /**
   * SIGUSR2 от выкладки: закрыть вход неживучим провайдерам на
   * PRE_RESTART_LEASE_MS. Скрипт повторяет сигнал на каждом шаге ожидания.
   * `true` — ожидание только что началось (для одной строки в журнале).
   */
  beginPreRestartDrain(): boolean {
    const started = !isPreRestartDrainActive();
    preRestartDrainUntil = Date.now() + PRE_RESTART_LEASE_MS;
    return started;
  },

  /** Used by health reporting and shutdown diagnostics. */
  isShutdownDraining(): boolean {
    return !acceptingNewRuns || isPreRestartDrainActive();
  },

  isRestartSafeProvider,

  /**
   * Counts this user's own currently-running runs, across every session.
   *
   * Used on OPEN_REGISTRATION instances (see chat-websocket.service.ts) as a
   * basic per-user concurrency cap: this shared VPS has no per-user OS-level
   * quota (systemd's MemoryMax/CPUQuota on the unit are whole-instance, not
   * per-user), so without this one registered user starting several heavy
   * Claude SDK sessions at once could crowd out every other user on the same
   * process. `userId` is read off each run's writer (ChatSessionWriter),
   * which is who chatRunRegistry.startRun() was given for that run.
   */
  countRunningRunsForUser(userId: string | number): number {
    let count = 0;
    for (const run of runs.values()) {
      if (run.status === 'running' && String(run.writer.userId) === String(userId)) {
        count += 1;
      }
    }
    return count;
  },

  /**
   * Re-attaches a run's outbound stream to a (new) websocket connection.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Записать причину неуспеха хода ДО его терминального `complete` — она
   * попадёт в журнал chat_runs и в плашку человеку. Зовут места, которые
   * знают причину: catch рантайма, сторож зависших ходов.
   */
  noteRunFailure(run: ChatRun, errorText: string): void {
    if (runs.get(run.appSessionId) === run && run.status === 'running') {
      run.lastErrorText = errorText.slice(0, 2000);
    }
  },

  /**
   * Добивка хода извне рантайма (сторож: процесс мёртв, а промис висит).
   * Пишет журнал и шлёт complete через обычный путь — как любой конец хода.
   */
  failRunSilentlyDead(run: ChatRun, errorText: string): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }
    this.noteRunFailure(run, errorText);
    try {
      run.writer.send({
        id: `run_failed_${run.runId}`,
        sessionId: run.appSessionId,
        timestamp: new Date().toISOString(),
        provider: run.provider,
        kind: 'error',
        role: 'assistant',
        content: errorText,
      } as NormalizedMessage);
    } catch {
      // сокет мёртв — журнал и run_terminal всё равно скажут правду
    }
    run.writer.sendComplete({ exitCode: 1 });
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
    acceptingNewRuns = true;
    preRestartDrainUntil = 0;
  },
};

/* ------------------------------------------------------------------ */
/*  Сторож ходов и сверка журнала при старте                           */
/* ------------------------------------------------------------------ */

/**
 * Обход сторожа: раз в 30 с — одна сверка реестра с реальностью. Дёшево:
 * существование процесса это stat по /proc, а метка активности уже лежит в
 * памяти хода.
 */
const RUN_WATCHDOG_INTERVAL_MS = 30_000;
/** Первые 90 с ходу верят на слово — процесс может ещё подниматься. */
const RUN_WATCHDOG_GRACE_MS = 90_000;
/**
 * Ход без единого события дольше этого — «завис при сборке». У рантаймов
 * свои таймауты рукопожатия, но не везде (ожидание живого замка, повторы):
 * без внешнего предела такой ход держал бы «работает» бесконечно.
 */
const RUN_STUCK_BOOTSTRAP_MS = 10 * 60_000;
/** Живой, но немой: столько без событий — честно говорим человеку. */
const RUN_STALL_NOTICE_MS = 15 * 60_000;
/**
 * Процесс мёртв — даём потоку пару секунд договорить финал самому
 * (событие 'close' обычно обгоняет обход), потом закрываем за него.
 */
const RUN_DEAD_CONFIRM_MS = 10_000;

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function sweepRunsOnce(): void {
  const now = Date.now();
  for (const run of runs.values()) {
    if (run.status !== 'running') {
      continue;
    }
    const age = now - run.startedAt;
    if (age < RUN_WATCHDOG_GRACE_MS) {
      continue;
    }

    // Единственный честный признак жизни: процесс, записавший себя в
    // live-runs. 'unknown' — записи нет (провайдер не переживает рестарт
    // или запись ещё/уже не лежит): по ней не судим о смерти.
    const alive = isRecordedAgentAlive(run.appSessionId);

    if (alive === false) {
      if (now - run.lastActivityAt < RUN_DEAD_CONFIRM_MS) {
        continue; // финал мог быть секунду назад — следующий обход решит
      }
      console.warn(`[run-watchdog] чат ${run.appSessionId}: процесс агента мёртв, а ход не отчитался — закрываю с причиной`);
      chatRunRegistry.failRunSilentlyDead(
        run,
        'Процесс агента завершился молча, не отдав результат. Отправьте сообщение ещё раз.',
      );
      continue;
    }

    if (run.promptAnchored && alive === true) {
      // Живой процесс без вывода — не смерть, но и не «всё в порядке»:
      // человеку видно, что ход реально ещё идёт, а не тихо умер.
      if (!run.stallNotified && now - run.lastActivityAt > RUN_STALL_NOTICE_MS) {
        run.stallNotified = true;
        const silentMin = Math.round((now - run.lastActivityAt) / 60_000);
        console.warn(`[run-watchdog] чат ${run.appSessionId}: процесс жив, но ${silentMin} мин без вывода`);
        try {
          run.writer.send({
            id: `stall_${run.runId}`,
            sessionId: run.appSessionId,
            timestamp: new Date().toISOString(),
            provider: run.provider,
            kind: 'status',
            text: `Ход идёт, но уже ${silentMin} мин без вывода — процесс жив, слежу за ним. Если завис насовсем, остановите его кнопкой.`,
          } as NormalizedMessage);
        } catch {
          // сокет мёртв — при подписке увидит свежий статус
        }
      }
      continue;
    }

    if (age > RUN_STUCK_BOOTSTRAP_MS && now - run.lastActivityAt > RUN_STUCK_BOOTSTRAP_MS) {
      console.warn(`[run-watchdog] чат ${run.appSessionId}: сборка хода висит ${Math.round(age / 60_000)} мин без единого события — закрываю`);
      chatRunRegistry.failRunSilentlyDead(
        run,
        'Запуск агента завис до начала ответа и не дожил до результата. Отправьте сообщение ещё раз.',
      );
    }
  }
}

/**
 * Сторож идущих ходов: раз в полминуты сверяет «running» с реальным
 * процессом. Умерший без complete получает терминальный статус и причину —
 * молчаливого подвисания больше нет.
 */
export function startRunWatchdog(): void {
  if (watchdogTimer) {
    return;
  }
  watchdogTimer = setInterval(sweepRunsOnce, RUN_WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref?.();
}

/**
 * Сверка журнала ходов при старте сервера (после adoptSurvivors!).
 *
 * Строки «running», которые никто не подхватил — от прошлого сервера,
 * умершего раньше времени (авария, OOM, kill). Живому процессу их ходы
 * adoptSurvivors уже отдал; оставшимся честно пишем «оборвано», а
 * недошедшее сообщение возвращаем в очередь — обход отправит заново.
 *
 * Возвращает число закрытых записей.
 */
export function reconcilePersistedRuns(): number {
  let rows;
  try {
    rows = chatRunsDb.listRunning();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[run-reconcile] журнал ходов не читается — сверка пропущена:', message);
    return 0;
  }
  if (rows.length === 0) {
    return 0;
  }

  let closed = 0;
  for (const row of rows) {
    // Живой ход — свой (уже в реестре) или усыновленный процесс прошлого
    // сервера. Это НЕ обрыв, строку не трогаем.
    if (runs.get(row.sessionId)?.status === 'running' || isSurvivorRunning(row.sessionId)) {
      continue;
    }

    const errorText = 'Прошлый ход оборвался вместе с сервером — результата не было.';
    try {
      chatRunsDb.finish(row.runId, { status: 'interrupted', error: errorText });
      closed += 1;
      console.warn(`[run-reconcile] ход ${row.runId} чата ${row.sessionId} остался «running» без живого процесса — закрыл как оборванный`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[run-reconcile] не удалось закрыть строку хода', { runId: row.runId, error: message });
      continue;
    }

    // Не доехавшее до агента сообщение возвращаем в очередь: смерть сервера
    // посреди сборки не должна съедать слова человека. append идемпотентен
    // по id — если штатное гашение уже вернуло её, копии не будет.
    if (!row.promptAnchored && row.pending) {
      try {
        chatMessageQueueDb.append({
          id: row.pending.id,
          sessionId: row.sessionId,
          userId: row.pending.userId,
          content: row.pending.content,
          options: row.pending.options ?? {},
        });
        console.warn(`[run-reconcile] сообщение ${row.pending.id} вернул в очередь чата ${row.sessionId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[run-reconcile] не удалось вернуть сообщение в очередь', { runId: row.runId, error: message });
      }
      try {
        chatRunsDb.clearPending(row.runId);
      } catch { /* уже ушло */ }
    }

    // Открытые вкладки узнают сразу, не дожидаясь подписки.
    try {
      broadcastRealtimeEvent(JSON.stringify({
        kind: 'run_terminal',
        sessionId: row.sessionId,
        provider: row.provider,
        status: 'interrupted',
        error: errorText,
        finishedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      }), row.provider);
    } catch { /* вкладок нет — подписка покажет то же из журнала */ }
  }
  return closed;
}

/** Только для тестов: один обход сторожа без ожидания интервала. */
export function sweepRunsOnceForTests(): void {
  sweepRunsOnce();
}

/** Только для тестов. */
export function stopRunWatchdogForTests(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}
