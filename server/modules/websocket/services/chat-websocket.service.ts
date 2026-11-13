import path from 'node:path';

import type { WebSocket } from 'ws';

import { chatMessageQueueDb, chatRunsDb, sessionsDb, type StoredQueuedChatMessage } from '@/modules/database/index.js';
import {
  getSurvivorPhase,
  getSurvivorProvider,
  isSurvivorRunning,
  providerModelsService,
  resolveEffectiveProvider,
  stopSurvivor,
  clampDevinModelForUser,
  clampProjectProviderModel,
  resolvePinnedSessionProvider,
  describeDevinFailureForUser,
} from '@/modules/providers/index.js';
import { chatRunRegistry, onChatRunCompleted } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  broadcastChatQueue,
  clearChatQueue,
  dispatchChatQueues,
  failQueuedMessageNow,
  listChatQueue,
  queueChatMessage,
  removeChatQueueItem,
  reorderChatQueue,
  returnClaimedToQueue,
  setQueuedChatMessageRunner,
  startChatQueueHeartbeat,
} from '@/modules/websocket/services/chat-queue.service.js';
import {
  hasAcceptedSend,
  readClientMessageId,
  rememberAcceptedSend,
} from '@/modules/websocket/services/chat-send-ledger.service.js';
import {
  broadcastRealtimeEvent,
  clientUserIds,
  connectedClients,
  WS_OPEN_STATE,
} from '@/modules/websocket/services/websocket-state.service.js';
import {
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
  RealtimeClientConnection,
} from '@/shared/types.js';
import type { ProviderAdoptedTurn, ProviderAdoptPayload, ProviderSteerPayload } from '@/shared/interfaces.js';
import { isCodexAllowedForWebUser, isPlatformOwnerWebUser, OPEN_REGISTRATION, parseIncomingJsonObject, resolveScopedWorkingDirectory } from '@/shared/utils.js';
import {
  getImageAssetsDirForUser,
  readRequestUserId,
  resolveWebUserRuntimeContext,
} from '@/shared/web-user-runtime.js';

/**
 * Basic per-user concurrency cap for OPEN_REGISTRATION instances (see
 * chatRunRegistry.countRunningRunsForUser()'s doc comment for why this is
 * needed at all on a shared VPS). Deliberately a small in-process constant
 * rather than a config value - the actual ceiling matters far less than the
 * fact that SOME ceiling exists, and 5 is generous for one interactive user
 * while still bounding the worst case (raised from 3 to 5 on 16.09.26 - one
 * person routinely keeps 3+ chats busy; 8 GB server has room).
 * Both ceilings read from env so the cap is tunable without a rebuild. The
 * box owner gets a separate, higher ceiling: their chats are most of the
 * interactive load, while the regular cap still bounds every other user's
 * aggregate footprint on the shared instance (owner ceiling added 15.10.26).
 */
function parseConcurrentRunLimit(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_CONCURRENT_RUNS_PER_USER = parseConcurrentRunLimit(process.env.CLOUDCLI_MAX_RUNS_PER_USER, 5);
const OWNER_MAX_CONCURRENT_RUNS = parseConcurrentRunLimit(process.env.CLOUDCLI_OWNER_MAX_RUNS, 10);

function maxConcurrentRunsForUser(userId: string | number): number {
  const numericUserId = Number(userId);
  return Number.isFinite(numericUserId) && isPlatformOwnerWebUser(numericUserId)
    ? OWNER_MAX_CONCURRENT_RUNS
    : MAX_CONCURRENT_RUNS_PER_USER;
}

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
  userIdForAssets?: string | number | null,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getImageAssetsDirForUser(userIdForAssets ?? null));

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  steer?(provider: LLMProvider, sessionId: string, payload: ProviderSteerPayload): Promise<boolean>;
  adopt?(provider: LLMProvider, sessionId: string, payload: ProviderAdoptPayload): Promise<ProviderAdoptedTurn | null>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
};


function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
/** Что увидит в чате человек без своего входа в Claude и без ключа API. */
const CLAUDE_LOGIN_REQUIRED_MESSAGE =
  'Войдите в Claude: Настройки → Агенты → Claude → «Войти». Или добавьте свой ключ API Anthropic там же.';

function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string,
  clientMessageId?: string | null,
  extra?: Record<string, unknown>,
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    ...(extra ?? {}),
    // Отказ по конкретному сообщению: телефон убирает его из очереди отправки
    // и больше не досылает (src/contexts/chatOutbox.ts).
    ...(clientMessageId ? { clientMessageId } : {}),
    timestamp: new Date().toISOString(),
  });
}

/** Метка страницы, понимающей расписки и `server_capabilities` (src/contexts/WebSocketContext.tsx). */
const CHAT_SEND_ACK_CAP = 'send-ack-1';
/**
 * Метка страницы, принимающей прикладной пинг `server_ping` (15.10.26).
 *
 * Протокольный ping/pong (heartbeat в websocket-server.service) для страницы
 * невидим: браузер отвечает на него сам, JS кадра не получает. Поэтому живой
 * с виду сокет на замёрзшем пути (смена сети, ТСПУ-«заморозка») страница не
 * замечала, пока сама что-то не отправляла. Прикладной кадр раз в
 * SERVER_PING_MS — это сигнал «путь жив», по которому сторож связи в
 * WebSocketContext считает молчание.
 */
const SERVER_PING_CAP = 'server-ping-1';
const SERVER_PING_MS = 25_000;

function readSocketCaps(request: AuthenticatedWebSocketRequest): string[] {
  const rawUrl = (request as { url?: string }).url || '';
  try {
    return (new URL(rawUrl, 'http://localhost').searchParams.get('caps') || '').split(',');
  } catch {
    return [];
  }
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const clientMessageId = readClientMessageId(data);
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.', undefined, clientMessageId);
    return;
  }

  // Копия уже принятого сообщения: расписка до телефона не дошла, и он
  // отправил его снова. Второй запуск не заводим — только расписываемся ещё
  // раз и подключаем эту связь к идущей работе.
  if (clientMessageId && hasAcceptedSend(sessionId, clientMessageId)) {
    console.log(`[Chat] повтор уже принятого сообщения ${clientMessageId} (чат ${sessionId}) — второй запуск не завожу`);
    if (chatRunRegistry.isProcessing(sessionId)) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }
    sendJson(ws, {
      kind: 'chat_send_ack',
      sessionId,
      clientMessageId,
      duplicate: true,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId,
      clientMessageId,
    );
    return;
  }

  let provider = session.provider as LLMProvider;

  // Чат привязанного проекта («Промпты»): человек выбрал другого помощника
  // в меню моделей — options.provider. Сессия переключается с этого
  // сообщения: новый мозг, честный значок, чат остаётся в списке вкладки
  // (Егор 25.10.26). Только явный разрешённый выбор — случайное значение
  // composer'а сессию не двигает.
  const requestedProvider =
    typeof (data.options as AnyRecord | undefined)?.provider === 'string'
      ? (data.options as AnyRecord).provider.trim()
      : null;
  const pinnedSwitchTarget = resolvePinnedSessionProvider(
    session.project_path,
    provider,
    requestedProvider,
  );
  const providerSwitched = Boolean(
    pinnedSwitchTarget && dependencies.runtime.hasRuntime(pinnedSwitchTarget),
  );
  if (providerSwitched && pinnedSwitchTarget) {
    sessionsDb.retargetSessionProvider(sessionId, pinnedSwitchTarget);
    provider = pinnedSwitchTarget;
    session.provider_session_id = null;
  }

  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId, clientMessageId);
    return;
  }

  // Доступа к Claude у человека общей площадки нет — чат мёртвого провайдера
  // переводится на корпоративный Devin: старая переписка остаётся в
  // jsonl_path (её доклеивает fetchHistory), новые ходы пишет Devin в своё
  // хранилище. Владельца и вошедших своим ключом это не касается — проверка
  // доступа внутри resolveEffectiveProvider.
  const effectiveProvider = await resolveEffectiveProvider(provider, userId);
  let providerMigrated = false;
  if (effectiveProvider !== provider) {
    if (dependencies.runtime.hasRuntime(effectiveProvider)) {
      sessionsDb.retargetSessionProvider(sessionId, effectiveProvider);
      provider = effectiveProvider;
      providerMigrated = true;
      session.provider_session_id = null;
      console.log(`[Chat] чат ${sessionId} переведён с Claude на ${effectiveProvider} — у пользователя ${String(userId)} нет доступа к Claude`);
    } else {
      sendProtocolError(
        ws,
        'CLAUDE_LOGIN_REQUIRED',
        CLAUDE_LOGIN_REQUIRED_MESSAGE,
        sessionId,
        clientMessageId,
      );
      return;
    }
  }

  // Вход в Codex на сервере один — хозяина (~/.codex). Гость общего
  // экземпляра писал бы на его подписку.
  if (provider === 'codex' && !isCodexAllowedForWebUser(userId)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', 'Codex недоступен для этого аккаунта.', sessionId, clientMessageId);
    return;
  }

  const userRunLimit = userId === null ? MAX_CONCURRENT_RUNS_PER_USER : maxConcurrentRunsForUser(userId);
  if (OPEN_REGISTRATION && userId !== null && chatRunRegistry.countRunningRunsForUser(userId) >= userRunLimit) {
    sendProtocolError(
      ws,
      'TOO_MANY_CONCURRENT_RUNS',
      `You already have ${userRunLimit} chats running at once. Wait for one to finish before starting another.`,
      sessionId,
      clientMessageId,
      // Страница не выбрасывает такое сообщение, а держит в очереди и досылает,
      // когда место освободится (src/contexts/chatOutbox.ts, «ждёт места»).
      { limit: userRunLimit },
    );
    return;
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  // options.provider — служебное поле выбора помощника в привязанном проекте,
  // съедено выше; провайдер-рантайму оно не нужно.
  delete clientOptions.provider;
  if (providerMigrated) {
    // Клиент прислал выбор для старого провайдера (модель/усилие Claude) —
    // Devin такие имена не знает, и ход упал бы на `--model claude-…`.
    delete clientOptions.model;
    delete clientOptions.effort;
  }
  if (providerSwitched) {
    // Явная смена помощника: модель сохраняется (это свежий выбор из меню
    // нового провайдера), усилие сбрасывается — значения Claude чужому
    // провайдеру не подходят.
    delete clientOptions.effort;
  }
  const command = typeof data.content === 'string' ? data.content : '';

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
    // Сообщение держим на ходу, пока оно не доехало до агента: сервер,
    // погибший посреди сборки хода, возвращает его в очередь (requeue),
    // иначе оно сгорало молча между «принято» и session/prompt.
    pendingMessage: {
      id: clientMessageId || `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      userId: userId === null ? null : String(userId),
      content: command,
      options: clientOptions,
    },
  });

  if (!run && data.sendNow === true) {
    // Ctrl/Cmd+Enter во время ответа — «отправить сейчас», без очереди.
    const steered = await steerIntoRunningTurn({ sessionId, userId, content: command, clientOptions, dependencies });
    if (steered) {
      if (clientMessageId) {
        rememberAcceptedSend(sessionId, clientMessageId);
        sendJson(ws, { kind: 'chat_send_ack', sessionId, clientMessageId, timestamp: new Date().toISOString() });
      }
      return;
    }
  }

  if (!run) {
    /*
     * Чат сейчас занят — это не отказ, а ОЧЕРЕДЬ.
     *
     * Раньше сюда возвращался `RUN_IN_PROGRESS`, а очередь следующих сообщений
     * вела сама вкладка и отправляла их, когда замечала конец хода. Пока сайт
     * закрыт, замечать некому: Егор 20.09.26 — «сообщение выложилось только
     * тогда, когда я вошёл в сайт». Теперь строка ложится в базу, а отправит
     * её сервер, как только ход закончится (chat-queue.service).
     */
    const queueId = clientMessageId || `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    queueChatMessage({
      id: queueId,
      sessionId,
      userId: userId === null ? null : String(userId),
      content: command,
      options: clientOptions,
    });
    console.log(`[Очередь чата] сообщение ${queueId} ждёт своего хода (чат ${sessionId})`);

    if (clientMessageId) {
      // Расписка нужна и здесь: без неё телефон считает сообщение недошедшим и
      // досылает его снова (src/contexts/chatOutbox.ts).
      rememberAcceptedSend(sessionId, clientMessageId);
      sendJson(ws, {
        kind: 'chat_send_ack',
        sessionId,
        clientMessageId,
        queued: true,
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  // Строка в очереди как write-ahead: до подтверждённой передачи prompt
  // агенту (якорь) сообщение лежит в базе захваченным — падение сервера или
  // хода вернёт его обходом очередей, а не потеряет (14.10.26). Захваченные
  // строки обход не трогает и док не показывает — внешне ничего не меняется.
  const pendingForWriteAhead = run.pendingMessage;
  if (pendingForWriteAhead) {
    try {
      chatMessageQueueDb.appendClaimedLast({
        id: pendingForWriteAhead.id,
        sessionId,
        userId: pendingForWriteAhead.userId,
        content: pendingForWriteAhead.content,
        options: pendingForWriteAhead.options,
      });
    } catch (writeAheadError) {
      // Без строки сообщение держит только память хода — не лучший вариант,
      // но ход запускать всё равно надо: ошибка записи не отменяет отправку.
      const text = writeAheadError instanceof Error ? writeAheadError.message : String(writeAheadError);
      console.error(`[Chat] write-ahead очереди не записался (чат ${sessionId}): ${text}`);
    }
  }

  // Расписка в получении — сразу, до обращения к провайдеру, который может
  // думать минуту. Пока её нет, телефон держит сообщение в очереди и
  // досылает (src/contexts/chatOutbox.ts). Номер запоминается ДО расписки:
  // если копия придёт после перезапуска сайта, её узнают по журналу.
  if (clientMessageId) {
    rememberAcceptedSend(sessionId, clientMessageId);
    console.log(`[Chat] принято сообщение ${clientMessageId} (чат ${sessionId})`);
    sendJson(ws, {
      kind: 'chat_send_ack',
      sessionId,
      clientMessageId,
      timestamp: new Date().toISOString(),
    });
  }

  await runProviderTurn({
    run,
    sessionId,
    provider,
    userId,
    projectPath: session.project_path ?? null,
    content: command,
    clientOptions,
    dependencies,
  });
}

/**
 * Вложения из настроек сообщения, перепроверенные сервером: до провайдера
 * доходят только файлы из общего хранилища загрузок, каждый один раз.
 */
function verifiedClientAttachments(clientOptions: AnyRecord, userId: string | number | null) {
  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates, undefined, userId);
  return verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );
}

/**
 * «Отправить сейчас»: сообщение уходит в идущий ход, а не ждёт его конца
 * (Егор 22.09.26: «не ждать, пока закончит — как в Cursor»). Claude прочтёт
 * его на ближайшем шаге, сделанное не пропадает (claude-runtime steerTurn).
 *
 * `false` — дописать нельзя: хода в памяти нет (агент пережил перезапуск
 * сайта, у сервера к нему нет канала), провайдер этого не умеет, или ход уже
 * отчитался о конце. Тогда сообщение остаётся в очереди.
 */
async function steerIntoRunningTurn(input: {
  sessionId: string;
  userId: string | number | null;
  content: string;
  clientOptions: AnyRecord;
  dependencies: ChatWebSocketDependencies;
}): Promise<boolean> {
  const { sessionId, userId, content, clientOptions, dependencies } = input;
  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running' || !dependencies.runtime.steer) {
    return false;
  }
  const attachments = verifiedClientAttachments(clientOptions, userId);
  const session = sessionsDb.getSessionById(sessionId);
  const runtimeContext = resolveWebUserRuntimeContext(userId);
  return dependencies.runtime.steer(run.provider, sessionId, {
    content,
    images: attachments.filter(isImageAttachmentDescriptor),
    files: attachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    cwd: resolveScopedWorkingDirectory(
      (typeof clientOptions.cwd === 'string' && clientOptions.cwd) || session?.project_path || undefined,
      runtimeContext.workspaceRoot,
    ),
  });
}

/** Заведённый запуск: и обычная отправка, и отправка из очереди ведут его одинаково. */
type StartedChatRun = NonNullable<ReturnType<typeof chatRunRegistry.startRun>>;

/**
 * Причина гибели хода словами человека. Devin-классы знают готовые
 * формулировки (лимит, вход, замок); остальное обрезаем до первой строки —
 * сырой хвост с trace id и журналом CLI человеку не помогает.
 */
function describeRunFailure(provider: LLMProvider, raw: string): string {
  if (provider === 'devin') {
    const human = describeDevinFailureForUser(raw);
    if (human) {
      return human;
    }
  }
  const firstLine = raw.replace(/\(trace id:[\s\S]*$/i, '').split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '';
  return (firstLine || 'Ход завершился ошибкой.').slice(0, 300);
}

/**
 * Ведёт один ход: разбирает настройки составителя, проверяет вложения и
 * отдаёт запрос провайдеру.
 *
 * Общая часть двух путей — сообщения, отправленного человеком прямо сейчас, и
 * снятого сервером с очереди. Раньше эта работа жила внутри `chat.send`, и
 * очередь пришлось бы повторять построчно.
 */
async function runProviderTurn(input: {
  run: StartedChatRun;
  sessionId: string;
  provider: LLMProvider;
  userId: string | number | null;
  projectPath: string | null;
  content: string;
  clientOptions: AnyRecord;
  dependencies: ChatWebSocketDependencies;
}): Promise<void> {
  const { run, sessionId, provider, userId, projectPath, content, clientOptions, dependencies } = input;
  let turnError: string | null = null;
  const runtimeContext = resolveWebUserRuntimeContext(userId);
  // Персональные белые списки (devin-model-policy): недопустимая для этого
  // аккаунта модель приводится к разрешённой до записи на сессию и до
  // передачи ходу провайдера — устаревший выбор или прямой вызов не сработают.
  clientOptions.model = clampDevinModelForUser(provider, userId, clientOptions.model);
  // Привязка проекта (project-provider-policy): у сессии вкладки «Промпты»
  // провайдер уже claude, но composer мог прислать модель прошлого выбора
  // ('swe-2-high') — она заменяется запасной моделью привязки.
  clientOptions.model = clampProjectProviderModel(provider, projectPath, clientOptions.model);
  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }

  const uniqueAttachments = verifiedClientAttachments(clientOptions, userId);

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  // Активный пресет промпта из шапки разговора. Клиент кладёт готовый текст
  // системной приписки в `presetSystemPrompt`; сюда переносим под именем,
  // которое понимает claude-runtime (appendSystemPrompt). Пресет живёт только
  // на времени одного запроса — сессия свою «системку» не хранит.
  const presetSystemPrompt =
    typeof clientOptions.presetSystemPrompt === 'string'
      ? clientOptions.presetSystemPrompt.trim()
      : '';

  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    // Языка размышлений модели не задаём: Егор 14.09.26 — «пусть Claude
    // размышляет на английском, он так умнее». На русский ключевые мысли
    // отбирает и переводит показ «Хода работы» (/api/user/thought-digest).
    appendSystemPrompt: presetSystemPrompt || undefined,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    // Рабочая зона не-владельца — его workspace; путь за её пределами
    // (устаревший, удалённый или чужой) приводится к корню зоны, чтобы
    // процесс ни при каких клиентских данных не стартовал в каталоге хоста.
    cwd: resolveScopedWorkingDirectory(
      (typeof clientOptions.cwd === 'string' && clientOptions.cwd.trim() ? clientOptions.cwd : undefined)
        ?? projectPath ?? undefined,
      runtimeContext.workspaceRoot,
    ),
    projectPath: resolveScopedWorkingDirectory(
      projectPath ?? (typeof clientOptions.projectPath === 'string' ? clientOptions.projectPath : undefined),
      runtimeContext.workspaceRoot,
    ),
    // Per-user Claude SDK env override (claude-runtime.provider.js). Both are
    // null outside OPEN_REGISTRATION, so the runtime falls back to
    // process.env exactly as it always has for Account 1/2.
    claudeConfigDir: runtimeContext.claudeConfigDir ?? undefined,
    anthropicApiKey: runtimeContext.anthropicApiKey ?? undefined,
    isolateInheritedClaudeAuth: runtimeContext.isolateInheritedClaudeAuth || undefined,
    // Рантайм отмечает, когда prompt реально попал к выживающему процессу
    // (Devin — session/prompt записан в сокет супервизора, Codex — worker
    // запущен, Claude — первое событие SDK). До якоря ход держит перезапуск,
    // а при гашении сообщение возвращается в очередь.
    onPromptAnchored: () => chatRunRegistry.markRunPromptAnchored(run),
  };

  try {
    // Прошлый ход этого чата закончился, но его процесс удержан ради фоновой
    // работы (фоновый агент/команда): сообщение уходит в ТОТ ЖЕ процесс новым
    // ходом. Новый `claude --resume` рядом с живым потерял бы результат фона.
    const adopted = dependencies.runtime.adopt
      ? await dependencies.runtime.adopt(provider, sessionId, {
        content,
        images: runtimeOptions.images,
        files: runtimeOptions.files,
        cwd: runtimeOptions.cwd,
        model: typeof clientOptions.model === 'string' ? clientOptions.model : undefined,
        permissionMode: typeof clientOptions.permissionMode === 'string' ? clientOptions.permissionMode : undefined,
        effort: typeof clientOptions.effort === 'string' ? clientOptions.effort : undefined,
        appendSystemPrompt: presetSystemPrompt || undefined,
        writer: run.writer,
      })
      : null;
    if (adopted) {
      // Сообщение ушло в уже живой выживающий процесс — ход заякорен.
      chatRunRegistry.markRunPromptAnchored(run);
      console.log(`[Chat] сообщение передано живому процессу чата ${sessionId} (идёт фоновая работа)`);
      await adopted.done;
    } else {
      await dependencies.runtime.run(provider, content, runtimeOptions, run.writer);
    }
  } catch (error) {
    turnError = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: turnError });
    // Причина — в журнал хода и в плашку человеку: без неё ход «просто
    // перестал» и страница после перезагрузки не знает, чем он кончился.
    chatRunRegistry.noteRunFailure(run, describeRunFailure(provider, turnError));
  } finally {
    // Строка очереди, которую вёз этот ход: доехала — снята с очереди на якоре
    // (markRunPromptAnchored → markDelivered). Не доехала — возвращаем со
    // счётчиком попыток, после потолка — видимая ошибка, а не тихая пропажа
    // (потеря 14.10.26, три сообщения чата 13fa2cd9). Отмена человеком уже
    // обнулила pendingMessage — отменённое не воскресаем.
    const pending = run.pendingMessage;
    if (pending && !run.promptAnchored) {
      run.pendingMessage = null;
      const outcome = returnClaimedToQueue(
        {
          id: pending.id,
          sessionId,
          userId: pending.userId,
          content: pending.content,
          options: (pending.options ?? {}) as Record<string, unknown>,
          createdAt: '',
        },
        turnError ?? 'ход завершился, не успев передать сообщение агенту',
      );
      if (outcome === 'requeued') {
        console.warn(`[Chat] сообщение ${pending.id} чата ${sessionId} не дошло до агента (${turnError ?? '?'}) — вернул в очередь`);
      } else {
        // Открытая вкладка видит сбой и в ленте: строка в доке очереди уже
        // помечена ошибкой, но лента — первое, куда смотрит человек.
        broadcastJson({
          kind: 'error',
          sessionId,
          provider,
          content: 'Сервер не смог передать сообщение агенту — оно осталось в очереди с ошибкой.',
          timestamp: new Date().toISOString(),
        });
      }
    }
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }
}

/**
 * Соединение-рассылка для запусков, заведённых САМИМ сервером (очередь).
 *
 * У обычной отправки есть сокет того, кто её послал; у сообщения из очереди
 * его может не быть вовсе — сайт закрыт. Поэтому события такого хода уходят
 * всем открытым вкладкам сразу: кто смотрит на этот чат, видит работу вживую,
 * остальные — плашку «работает» в списке. Как только вкладка подпишется на
 * чат (`chat.subscribe`), поток переключится на неё обычным порядком.
 */
const broadcastConnection = (provider?: string | null): RealtimeClientConnection => ({
  readyState: WS_OPEN_STATE,
  send(data: string): void {
    broadcastRealtimeEvent(data, provider);
  },
});

function broadcastJson(payload: unknown): void {
  const record = payload as AnyRecord;
  broadcastRealtimeEvent(JSON.stringify(payload), typeof record.provider === 'string' ? record.provider : null);
}

/**
 * Devin-чат — собственность инициировавшего пользователя (как и любой чат):
 * чужой сокет не должен наблюдать его поток, отвечать на его permission-
 * запросы, останавливать его или править очередь. Наследие без автора —
 * только владельцу площадки. Нет строки — гейтить нечего.
 */
function isDevinSessionForbiddenForUser(
  sessionId: string | null | undefined,
  userId: string | number | null,
): boolean {
  if (!OPEN_REGISTRATION || !sessionId) {
    return false;
  }
  const session = sessionsDb.getSessionById(sessionId);
  if (session?.provider !== 'devin') {
    return false;
  }
  const numericUserId = userId === null || userId === undefined ? NaN : Number(userId);
  if (Number.isFinite(numericUserId) && isPlatformOwnerWebUser(numericUserId)) {
    return false;
  }
  return !Number.isFinite(numericUserId)
    || session.initiated_by_user_id == null
    || Number(session.initiated_by_user_id) !== numericUserId;
}

/**
 * Отправляет сообщение, снятое с очереди: заводит запуск без участия браузера.
 *
 * Возвращает `false`, если запуск завести нельзя ПРЯМО СЕЙЧАС (чат успел
 * заняться, исчерпан предел одновременных чатов) — вызывающий вернёт строку в
 * начало очереди. `true` означает «строку больше не хранить»: либо ход
 * запущен, либо отправлять её некуда (чат удалён, провайдер отключён) и
 * держать её вечно бессмысленно.
 */
async function runQueuedChatMessage(
  message: StoredQueuedChatMessage,
  dependencies: ChatWebSocketDependencies,
): Promise<boolean> {
  const sessionId = message.sessionId;
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    console.warn(`[Очередь чата] чат ${sessionId} не найден — сообщение ${message.id} отброшено`);
    // Чата нет — и док показывать некуда: строку просто снимаем.
    chatMessageQueueDb.markDelivered(message.id);
    return true;
  }

  let provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    console.warn(`[Очередь чата] провайдер "${provider}" недоступен — сообщение ${message.id} помечено ошибкой`);
    failQueuedMessageNow(message, `провайдер "${provider}" недоступен`);
    return true;
  }

  const userId = message.userId;
  // Та же миграция, что в handleChatSend: стоявшее в очереди сообщение чата
  // мёртвого провайдера уходит через корпоративный Devin, а не отбрасывается.
  const effectiveProvider = await resolveEffectiveProvider(provider, userId);
  let providerMigrated = false;
  if (effectiveProvider !== provider) {
    if (dependencies.runtime.hasRuntime(effectiveProvider)) {
      sessionsDb.retargetSessionProvider(sessionId, effectiveProvider);
      provider = effectiveProvider;
      providerMigrated = true;
      session.provider_session_id = null;
    } else {
      console.warn(`[Очередь чата] пользователь ${String(userId)} не вошёл в Claude и не добавил ключ — сообщение ${message.id} помечено ошибкой`);
      failQueuedMessageNow(message, 'нет доступа к Claude (вход или ключ в «Настройки → Агенты»)');
      return true;
    }
  }

  if (provider === 'codex' && !isCodexAllowedForWebUser(userId)) {
    console.warn(`[Очередь чата] Codex недоступен пользователю ${String(userId)} — сообщение ${message.id} помечено ошибкой`);
    failQueuedMessageNow(message, 'Codex недоступен этому пользователю');
    return true;
  }

  // Предел одновременных чатов: место освободится — строку заберёт следующий
  // обход очередей, поэтому здесь именно «вернуть в очередь», а не «отбросить».
  if (OPEN_REGISTRATION && userId !== null && chatRunRegistry.countRunningRunsForUser(userId) >= maxConcurrentRunsForUser(userId)) {
    return false;
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: broadcastConnection(provider),
    userId,
    // Тот же якорь, что у прямой отправки: снятая с очереди строка уже не в
    // базе — до доставки prompt агенту её держит ход, а при гашении сервера
    // вернёт в очередь.
    pendingMessage: {
      id: message.id,
      userId: message.userId === null ? null : String(message.userId),
      content: message.content,
      options: (message.options ?? {}) as AnyRecord,
    },
  });
  if (!run) {
    return false;
  }

  // Копия: `message.options` — тот же объект, что у pendingMessage, а там
  // живут служебные ключи доставки (__redispatch, __notBefore) — из копии
  // их убираем, чтобы провайдеру служебное не уезжало, из записи — не стираем.
  const clientOptions = { ...((message.options ?? {}) as AnyRecord) };
  delete clientOptions.__redispatch;
  delete clientOptions.__notBefore;
  if (providerMigrated) {
    // Модель/усилие в сообщении выбраны под старый провайдер — Devin их не знает.
    delete clientOptions.model;
    delete clientOptions.effort;
  }
  console.log(`[Очередь чата] отправляю сообщение ${message.id} (чат ${sessionId})`);

  // Плашка «работает» во всех вкладках: ход начался не по нажатию человека,
  // и узнать о нём странице больше неоткуда.
  broadcastJson({
    kind: 'chat_run_started',
    sessionId,
    provider,
    timestamp: new Date().toISOString(),
  });

  // Само сообщение человека — в ленту: писал его человек, отправил сервер, и
  // без этого в переписке ответ появлялся бы без вопроса. Строка уходит через
  // запуск, поэтому она же попадает в досылку вкладке, открытой посреди хода.
  const attachments = filterAttachmentsToUploadStore(
    [
      ...normalizeAttachmentDescriptors(clientOptions.attachments),
      ...normalizeAttachmentDescriptors(clientOptions.images),
      ...normalizeAttachmentDescriptors(clientOptions.files),
    ],
    undefined,
    userId,
  );
  const uniqueAttachments = attachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );
  run.writer.send({
    id: `queued_${message.id}`,
    sessionId,
    timestamp: new Date().toISOString(),
    provider,
    kind: 'text',
    role: 'user',
    content: message.content,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
  } as NormalizedMessage);

  // Ход ведём в фоне: обход очередей ждать его конца не должен — он длится
  // минутами, а за ним стоят очереди других чатов.
  void runProviderTurn({
    run,
    sessionId,
    provider,
    userId,
    projectPath: session.project_path ?? null,
    content: message.content,
    clientOptions,
    dependencies,
  }).catch((error) => {
    const text = error instanceof Error ? error.message : String(error);
    console.error('[Очередь чата] ход из очереди завершился ошибкой', { sessionId, error: text });
  });

  return true;
}

/**
 * Поднимает серверную очередь сообщений: кто её отправляет и когда.
 *
 * Вызывается один раз при создании websocket-сервера. С этого момента очередь
 * живёт без браузера: конец любого хода — сигнал обойти очереди и отправить
 * первое сообщение каждого освободившегося чата.
 */
export function initChatQueueDispatch(dependencies: ChatWebSocketDependencies): void {
  setQueuedChatMessageRunner((message) => runQueuedChatMessage(message, dependencies));
  onChatRunCompleted(() => {
    dispatchChatQueues();
  });
  // Захваты прошлого процесса: его держатели мертвы, а строки обязаны доехать.
  // Снимаем их до первого обхода — иначе строки висели бы невидимками.
  const released = chatMessageQueueDb.releaseAllClaims();
  if (released > 0) {
    console.warn(`[Очередь чата] снято ${released} захват(а/ов) прошлого процесса — строки вернулись в очередь`);
  }
  // Перезапуск сайта (выкатка, перезагрузка) не должен задерживать очередь,
  // но и подхват выживших агентов ещё не закончился: обход отсюда снимал
  // строку до того, как isSurvivorRunning узнал о держателе сессии, — запуск
  // упирался в session_locked и сообщение сгорало (потеря 14.10.26). Первый
  // обход делает index.ts ПОСЛЕ adoptSurvivors, до него — раз в минуту сторож.
  startChatQueueHeartbeat();
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  if (isDevinSessionForbiddenForUser(sessionId, userId)) {
    sendProtocolError(ws, 'PROVIDER_NOT_ALLOWED', 'The Devin provider is only available to the platform owner.', sessionId);
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  // Человек нажал «остановить» ДО того, как prompt доехал до агента: сообщение
  // не воскрешать — снимаем его и с хода, и со строки очереди, и из журнала
  // хода, иначе обход отправил бы «отменённое» снова.
  if (run && run.status === 'running' && !run.promptAnchored && run.pendingMessage) {
    const cancelled = run.pendingMessage;
    run.pendingMessage = null;
    try {
      chatMessageQueueDb.remove(sessionId, cancelled.id);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error(`[Chat] остановка хода ${sessionId}: не удалось снять сообщение ${cancelled.id} с очереди: ${text}`);
    }
    try {
      chatRunsDb.clearPending(run.runId);
    } catch {
      // журнал не написался — сверка при старте подчистит
    }
  }
  // Агент пережил перезапуск сайта: канала к нему у сервера нет, остановить
  // можно только сигналом процессу.
  if ((!run || run.status !== 'running') && isSurvivorRunning(sessionId)) {
    const survivorProvider = getSurvivorProvider(sessionId);
    stopSurvivor(sessionId);
    // «Работа завершена» с отметкой отмены: «чат свободен» вкладка может
    // отбросить как устаревший (см. onGone в server/index.ts).
    sendJson(ws, {
      kind: 'complete',
      sessionId,
      actualSessionId: sessionId,
      provider: survivorProvider,
      exitCode: 0,
      aborted: true,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const success = await dependencies.runtime.abort(run.provider, sessionId);

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    if (isDevinSessionForbiddenForUser(sessionId, userId)) {
      sendProtocolError(ws, 'PROVIDER_NOT_ALLOWED', 'The Devin provider is only available to the platform owner.', sessionId);
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const clientLastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;
    const clientRunRaw = (target as AnyRecord).runStartedAt;
    const clientRunStartedAt = typeof clientRunRaw === 'number' && Number.isFinite(clientRunRaw)
      ? clientRunRaw
      : null;

    const run = chatRunRegistry.getRun(sessionId);

    // Счётчик вкладки годится для досылки, только если он про ЭТУ работу.
    // Нумерация у каждой работы своя, и вкладка, пережившая прошлую долгую
    // работу, помнит номер, до которого новая ещё не дошла, — досылка по нему
    // вернула бы пустоту. 13.09.26 так у Егора пропадала плашка «работает»:
    // сервер чат считал занятым, а вкладка ни одного события не получала.
    // Старая вкладка без метки: номер больше, чем у работы вообще бывает, —
    // точно чужой, досылаем с начала.
    const lastSeq = run
      && ((clientRunStartedAt !== null && clientRunStartedAt !== run.startedAt)
        || (clientRunStartedAt === null && clientLastSeq > run.lastSeq))
      ? 0
      : clientLastSeq;
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    // У пережившего перезапуск агента живого потока нет — этап берётся из
    // хвоста его переписки, иначе вкладка показывает «Ожидает модель».
    const survivorPhase = isProcessing && (!run || run.status !== 'running')
      ? getSurvivorPhase(sessionId)
      : null;

    // Чем кончился последний ход — вкладке, открывшей чат после конца:
    // живые события исхода ушли в сокет, которого могло уже не быть
    // (iOS убивает страницу в фоне), а журнал chat_runs терминальный
    // исход держит всегда. Показываем только неуспех — «завершился
    // нормально» баннером не нужен.
    let lastRun: Record<string, unknown> | null = null;
    if (!isProcessing) {
      try {
        const finished = chatRunsDb.latestFinishedForSession(sessionId);
        if (finished && finished.status !== 'completed') {
          lastRun = {
            status: finished.status,
            error: finished.error,
            finishedAt: finished.finishedAt,
          };
        }
      } catch {
        // журнал не читается — работе подписки это не мешает
      }
    }

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      phase: survivorPhase?.phase ?? null,
      phaseDetail: survivorPhase?.detail ?? null,
      lastSeq: run?.lastSeq ?? 0,
      runStartedAt: run?.startedAt ?? null,
      pendingPermissions,
      lastRun,
      // Очередь приходит вместе с состоянием чата: вкладка её только
      // показывает, хранит и отправляет сервер.
      queue: listChatQueue(sessionId),
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * `chat.queue.sendNow`: кнопка «Сейчас» у сообщения в очереди.
 *
 * Строка снимается с очереди ДО передачи: пока идёт передача, ход может
 * закончиться, и обход очереди отправил бы ту же строку второй раз. Не
 * получилось — строка возвращается в начало очереди, человеку объясняем.
 * Чат уже свободен — строка встаёт первой и уходит обычным путём.
 */
async function handleChatQueueSendNow(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  const id = typeof data.id === 'string' ? data.id.trim() : '';
  if (!sessionId || !id) {
    sendProtocolError(ws, 'QUEUE_ITEM_ID_REQUIRED', 'chat.queue.sendNow requires a sessionId and an id.', sessionId ?? undefined);
    return;
  }
  const queue = chatMessageQueueDb.list(sessionId);
  const item = queue.find((entry) => entry.id === id);
  if (!item) {
    // Уже ушло (второе нажатие, другое устройство, конец хода) — делать нечего.
    return;
  }
  if (item.claimedAt) {
    // Строку уже везёт ход — «Сейчас» не нужно, она и так в пути.
    return;
  }
  if (item.state === 'failed') {
    // «Сейчас» на отказавшей строке — это ручной повтор: ошибку стираем,
    // строка снова обычная ждущая.
    chatMessageQueueDb.markQueued(item.id);
  }

  if (!chatRunRegistry.isProcessing(sessionId)) {
    reorderChatQueue(sessionId, [id, ...queue.filter((entry) => entry.id !== id && !entry.claimedAt).map((entry) => entry.id)]);
    dispatchChatQueues();
    return;
  }

  // Захватываем строку ДО передачи: пока идёт передача, ход может закончиться,
  // и обход очереди отправил бы ту же строку второй раз. Не получилось —
  // захват возвращается, человеку объясняем.
  if (!chatMessageQueueDb.claim(id)) {
    return;
  }
  broadcastChatQueue(sessionId);
  let steered = false;
  try {
    steered = await steerIntoRunningTurn({
      sessionId,
      userId: item.userId,
      content: item.content,
      clientOptions: item.options ?? {},
      dependencies,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Очередь чата] «отправить сейчас» не удалось', { sessionId, error: message });
  }
  if (steered) {
    // Сообщение уже в идущем ходе — та же подтверждённая доставка, что и якорь.
    chatMessageQueueDb.markDelivered(id);
    broadcastChatQueue(sessionId);
    console.log(`[Очередь чата] сообщение ${id} отправлено в идущий ход (чат ${sessionId})`);
    return;
  }

  chatMessageQueueDb.releaseClaim(id);
  broadcastChatQueue(sessionId);
  // Ход мог закончиться, пока шла попытка: тогда строка уйдёт обычным путём.
  dispatchChatQueues();
  sendProtocolError(
    ws,
    'SEND_NOW_UNAVAILABLE',
    'Не получилось передать сообщение в идущий ответ — оно осталось в очереди и уйдёт, как только ответ закончится.',
    sessionId,
  );
}

/**
 * Правка очереди с любого устройства: убрать строку, переставить порядок,
 * очистить. Очередь общая и лежит на сервере, поэтому изменение тут же
 * рассылается всем вкладкам (chat-queue.service).
 */
function handleChatQueueEdit(ws: WebSocket, userId: string | number | null, messageType: string, data: AnyRecord): void {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${messageType} requires a sessionId.`);
    return;
  }

  if (isDevinSessionForbiddenForUser(sessionId, userId)) {
    sendProtocolError(ws, 'PROVIDER_NOT_ALLOWED', 'The Devin provider is only available to the platform owner.', sessionId);
    return;
  }

  if (messageType === 'chat.queue.remove') {
    const id = typeof data.id === 'string' ? data.id.trim() : '';
    if (!id) {
      sendProtocolError(ws, 'QUEUE_ITEM_ID_REQUIRED', 'chat.queue.remove requires an id.', sessionId);
      return;
    }
    removeChatQueueItem(sessionId, id);
    return;
  }

  if (messageType === 'chat.queue.clear') {
    clearChatQueue(sessionId);
    return;
  }

  // chat.queue.reorder
  const ids = Array.isArray(data.ids)
    ? data.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (ids.length === 0) {
    sendProtocolError(ws, 'QUEUE_ORDER_REQUIRED', 'chat.queue.reorder requires ids.', sessionId);
    return;
  }
  reorderChatQueue(sessionId, ids);
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 * - `chat.queue.remove`        { sessionId, id }
 * - `chat.queue.reorder`       { sessionId, ids }
 * - `chat.queue.clear`         { sessionId }
 * - `chat.queue.sendNow`       { sessionId, id } — в идущий ход, не ждать конца
 *
 * `chat.send` с `sendNow: true` в занятый чат тоже уходит в идущий ход.
 *
 * `chat.send` в занятый чат не отказ, а очередь: сообщение ложится в базу и
 * уходит само по концу хода (chat-queue.service). Очередь чата приходит
 * вкладке в ответе `chat_subscribed` и в рассылке `chat_queue`.
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  const ua = String(request.headers?.['user-agent'] ?? '');
  const uaShort = /iPhone/.test(ua) ? 'iPhone' : /Mac/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : ua.slice(0, 40) || '?';
  console.log(`[INFO] Chat WebSocket connected ua=${uaShort}`);
  connectedClients.add(ws);
  // Первым делом — что умеет этот сервер. Страница досылает сообщения только
  // серверу, который расписывается в получении и узнаёт повторы; со старым
  // сервером повтор давал «already has a run in progress» (15.09.26).
  // Шлём только странице, которая сама сказала, что понимает это событие
  // (`caps` в адресе подключения): старая страница вывела бы незнакомое
  // событие в ленту строкой.
  const socketCaps = readSocketCaps(request);
  if (socketCaps.includes(CHAT_SEND_ACK_CAP)) {
    sendJson(ws, { kind: 'server_capabilities', chatSendAck: true, serverPingMs: SERVER_PING_MS });
  }

  // Прикладной пинг, видимый странице — только ей (кадр `server_ping`):
  // протокольный ping браузер проглатывает молча, и страница не может
  // отличить живой сокет от замёрзшего в пути. Шлём только заявившим
  // `server-ping-1`: старая страница показала бы кадр в ленте строкой.
  let appPingTimer: ReturnType<typeof setInterval> | null = null;
  if (socketCaps.includes(SERVER_PING_CAP)) {
    appPingTimer = setInterval(() => {
      try {
        sendJson(ws, { kind: 'server_ping', timestamp: new Date().toISOString() });
      } catch {
        // сокет умер между проверкой состояния и отправкой — сторож приберёт
      }
    }, SERVER_PING_MS);
    appPingTimer.unref?.();
  }

  const userId = readRequestUserId(request);
  clientUserIds.set(ws, userId);

  ws.on('message', async (rawMessage) => {
    let clientMessageId: string | null = null;
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      clientMessageId = readClientMessageId(data);
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, userId, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, userId, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        case 'chat.queue.remove':
        case 'chat.queue.reorder':
        case 'chat.queue.clear':
          handleChatQueueEdit(ws, userId, messageType, data);
          return;
        case 'chat.queue.sendNow':
          await handleChatQueueSendNow(ws, data, dependencies);
          return;
        case 'ping':
          // Проба связи от сторожа страницы: любой ответ доказывает, что
          // сокет жив. `server_pong` — чтобы отличать от других кадров.
          sendJson(ws, { kind: 'server_pong', timestamp: new Date().toISOString() });
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message, undefined, clientMessageId);
    }
  });

  // Код закрытия отличает уход страницы (1001) от её внезапной смерти (1006 —
  // телефон выгрузил страницу из памяти, не попрощавшись). 25.09.26 белый экран
  // на iPhone не оставлял следа — этот код один из немногих признаков.
  const openedAt = Date.now();
  ws.on('close', (code: number) => {
    console.log(`[INFO] Chat client disconnected code=${code} livedSec=${Math.round((Date.now() - openedAt) / 1000)} ua=${uaShort}`);
    if (appPingTimer) {
      clearInterval(appPingTimer);
      appPingTimer = null;
    }
    connectedClients.delete(ws);
  });
}
