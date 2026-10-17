import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  appendFilesInputTag,
  appendImagesInputTag,
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  noteSurvivorProviderSession,
  registerProviderRun,
} from '@/modules/providers/list/claude/survivor-runs.js';
import {
  connectSupervisedDevin,
  spawnSupervisedDevin,
} from '@/modules/providers/list/devin/devin-acp-client.js';
import { wrapInAgentRoom } from '@/shared/agent-rooms.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  devinConnectionsService,
  classifyDevinFailure,
  isFailoverableFailure,
} from '@/modules/providers/services/devin-connections.service.js';
import {
  buildDevinChildEnv,
  createCompleteMessage,
  createNormalizedMessage,
  DEVIN_DEFAULT_MODEL,
  getDevinDatabasePath,
  isAllowedDevinModel,
  resolveDevinCliCommand,
} from '@/shared/utils.js';
import { mapPermissionModeToDevinMode } from '@/modules/providers/list/devin/devin-sessions.provider.js';
import { readDevinTokenUsage } from '@/modules/providers/list/devin/devin-usage.js';

/**
 * Live Devin ACP processes keyed by the app-facing session id.
 *
 * `abort()` looks a run up here; the entry also carries the flags the stream
 * loop needs (`aborted` suppresses the runtime's own `complete` — the abort
 * handler has already emitted one).
 */
const activeDevinRuns = new Map();

/**
 * Незакрытые запросы разрешений Devin (permission gateway → UI).
 * requestId → { requestId, sessionKey, toolName, input, options, receivedAt,
 * respond, reattached }.
 *
 * `sessionKey` — app-session-id (как у claude: по нему chat.subscribe ищет
 * ожидающие запросы). `respond` пишет JSON-RPC-ответ агенту — напрямую в
 * соединение хода или через сокет супервизора у переподключённого чата.
 */
const pendingPermissions = new Map();

/** Переподключённые после рестарта супервизор-линки по appSessionId. */
const reattachedDevinSurvivors = new Map();

/**
 * Проверяет, что текст ответа ассистента — не финальный, а только
 * статусный/вводный блок. Используется как защита от тихого обрывания хода
 * после «Как я понял задачу» или промежуточного статуса.
 */
function isIncompleteDevinResponse(text, hasToolCalls) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  // Если были вызовы инструментов, считаем, что работа шла — оставляем
  // эвристику только для чисто текстовых обрывов.
  if (hasToolCalls) {
    const lower = t.toLowerCase();
    // Даже после инструментов недопустимо заканчивать на «сейчас сделаю»
    // без результата.
    if (/сейчас (докину|сделаю|поищу|проверю|вернусь)/i.test(t)) return true;
    return false;
  }
  const lower = t.toLowerCase();
  // Только блок «Как я понял задачу» — явно не финал.
  if (lower.startsWith('## как я понял задачу') && !/(^|\n)## (ответ|итог|результат|таблица|как сделать|готово|не вышло|дальше)($|\s)/mi.test(t)) {
    return true;
  }
  // Промежуточный статус без результирующего блока.
  if (/сейчас (докину|сделаю|поищу|проверю|вернусь)/i.test(t)) return true;
  if (/ещё не готово|пока не готово|жду|продолжаю работу/i.test(t) && !/(^|\n)## (ответ|итог|результат|таблица|как сделать|готово|не вышло|дальше)($|\s)/mi.test(t)) {
    return true;
  }
  return false;
}

/** How long `abort` lets Devin wind down before SIGKILLing it. */
const ABORT_GRACE_MS = 3_000;
/** Devin пишет расход ответа в свою sessions.db — живой счётчик раз в 4 с. */
const DEVIN_USAGE_POLL_MS = 4_000;
/**
 * session_locked с ЖИВЫМ держателем (11.10.26): беседу обрабатывает другой
 * процесс `devin acp` — это «чат занят», а не ошибка. Ждём конца держателя
 * (он пишет в ту же sessions.db), потом session/load идёт как обычно.
 */
const LOCK_HOLDER_POLL_MS = 2_000;
const LOCK_HOLDER_WAIT_MS = 30 * 60_000;
const LOCK_ZOMBIE_RETRIES = 3;
/** initialize/session/new must answer promptly; a hung handshake = broken CLI. */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** Devin logs progress to stderr (INFO lines) — keep the tail for error text. */
const STDERR_TAIL_BYTES = 4_000;

function isDevinPidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('devin') && cmdline.includes('acp');
  } catch {
    return false;
  }
}

/**
 * Сохраняет в ход значения опции `model` из configOptions сессии (ответ
 * session/new / session/load или событие config_option_update). Это список
 * реально доступных каналу моделей — честнее каталога CLI. Ключ — канал
 * (Connection Layer), а не слот: `devin-model-options-<connId>.json`.
 */
const channelModelOptions = new Map(); // connId -> Set<string>
// Путь считается на каждый вызов: тесты подменяют HOME после загрузки модуля.
const channelModelsFile = (connId) => path.join(os.homedir(), '.cloudcli-shared', `devin-model-options-${connId}.json`);

function rememberChannelModelOptions(connId, options) {
  if (!(options instanceof Set) || options.size === 0 || connId == null) return;
  const key = String(connId);
  channelModelOptions.set(key, options);
  try {
    fs.mkdirSync(path.dirname(channelModelsFile(key)), { recursive: true });
    fs.writeFileSync(channelModelsFile(key), JSON.stringify([...options]));
  } catch { /* список останется в памяти процесса — некритично */ }
}

// Используется devin-models.provider.ts: пикер моделей пересекает каталог
// `devin models list` с реальным списком каналов (union — модель показываем,
// если её держит хотя бы один канал; точный выбор всё равно клампится ходом).
export function readChannelModelOptions() {
  const union = new Set();
  for (const set of channelModelOptions.values()) for (const v of set) union.add(v);
  try {
    const dir = path.join(os.homedir(), '.cloudcli-shared');
    for (const name of fs.readdirSync(dir)) {
      const m = /^devin-model-options-(.+)\.json$/.exec(name);
      if (!m) continue;
      try {
        const values = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (Array.isArray(values)) for (const v of values) union.add(String(v));
      } catch { /* битый файл пропускаем */ }
    }
  } catch { /* каталога ещё нет */ }
  return union.size ? union : null;
}

function noteConfigOptions(run, configOptions) {
  if (!Array.isArray(configOptions)) return;
  const model = configOptions.find((o) => o && o.id === 'model');
  if (!model) return;
  const values = (model.options || []).map((o) => String(o?.value || '')).filter(Boolean);
  if (values.length) run.modelOptions = new Set(values);
  if (typeof model.currentValue === 'string' && model.currentValue) run.modelCurrent = model.currentValue;
  rememberChannelModelOptions(run.lane?.id, run.modelOptions);
}

/**
 * Шлёт вкладке актуальный `token_budget` чата Devin из sessions.db его
 * канала (заполненность окна по последнему ответу живой цепи). Повтор с тем
 * же `used` не шлём — счётчик и так стоит. Раньше здесь стояло
 * `total = used` из prompt.usage, и кнопка показывала «150K/150K».
 */
function emitDevinTokenBudget(ws, run, appSessionId, { force = false } = {}) {
  const devinSessionId = run.devinSessionId;
  if (!devinSessionId) {
    return;
  }
  let usage = null;
  try {
    usage = readDevinTokenUsage(devinSessionId, {
      modelHint: run.resolvedModel,
      xdgDataHome: run.lane?.xdg_data_home ?? null,
    });
  } catch {
    return; // база занята/недоступна — следующий тик или конец хода дочитает
  }
  if (!usage || (!force && usage.used === run.lastEmittedUsage)) {
    return;
  }
  run.lastEmittedUsage = usage.used;
  sendMessage(ws, createNormalizedMessage({
    provider: 'devin',
    sessionId: appSessionId || devinSessionId,
    kind: 'status',
    text: 'token_budget',
    tokenBudget: {
      used: usage.used,
      total: usage.contextWindow,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      breakdown: usage.breakdown,
      contextTokens: usage.contextTokens,
      contextWindow: usage.contextWindow,
    },
  }));
}

function sendMessage(ws, data) {
  if (ws && typeof ws.send === 'function') {
    try {
      ws.send(data);
    } catch (error) {
      console.error('Error sending Devin stream message:', error);
    }
  }
}

/**
 * Minimal line-delimited JSON-RPC client over one child's stdout/stdin.
 * Devin's ACP stream also emits server-initiated requests
 * (`session/request_permission`, ...) which the runtime answers.
 */
function createAcpConnection(child, { onNotification, onRequest, onClose }) {
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let stderrTail = '';
  let closed = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // ACP writes INFO logs to stderr, but a stray stdout line must not
        // crash the turn — skip it.
        console.warn('[Devin] Ignoring non-JSON stdout line:', line.slice(0, 200));
        continue;
      }

      if (msg.method && msg.id !== undefined) {
        // Agent-initiated request (permission prompt, fs/*, terminal/*).
        onRequest(msg);
      } else if (msg.method) {
        onNotification(msg);
      } else if (msg.id !== undefined) {
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          if (msg.error) {
            const err = new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`);
            err.code = msg.error.code;
            waiter.reject(err);
          } else {
            waiter.resolve(msg.result ?? {});
          }
        }
      }
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const { reject } of pending.values()) {
      reject(new Error('Devin process exited'));
    }
    pending.clear();
    onClose?.();
  };
  child.once('close', close);

  return {
    call(method, params, timeoutMs = 0) {
      if (closed) {
        return Promise.reject(new Error('Devin process already exited'));
      }
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (timeoutMs > 0) {
          waiter.timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Devin ACP "${method}" timed out`));
          }, timeoutMs);
          waiter.timer.unref?.();
        }
        pending.set(id, {
          resolve: (value) => { if (waiter.timer) clearTimeout(waiter.timer); resolve(value); },
          reject: (error) => { if (waiter.timer) clearTimeout(waiter.timer); reject(error); },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) {
      if (closed) {
        return;
      }
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
      } catch {
        // Dead process — nothing to notify.
      }
    },
    respond(id, result) {
      if (closed) {
        return;
      }
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      } catch {
        // Dead process.
      }
    },
    respondError(id, code, message) {
      if (closed) {
        return;
      }
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
      } catch {
        // Dead process.
      }
    },
    getStderrTail() {
      return stderrTail;
    },
    isClosed() {
      return closed;
    },
  };
}

/**
 * ACP toolCall → имя для баннера разрешения: настоящее имя инструмента из
 * `_meta`, иначе человекочитаемый заголовок (тот же приоритет, что и у
 * tool_call в ленте — devin-sessions.provider.ts readToolName).
 */
function readPermissionToolName(toolCall) {
  const meta = toolCall?._meta && typeof toolCall._meta === 'object' ? toolCall._meta : null;
  const inferenceName = meta?.['cognition.ai/inferenceToolName'];
  if (typeof inferenceName === 'string' && inferenceName.trim()) {
    return inferenceName.trim();
  }
  // Живой запрос разрешения Devin несёт урезанный toolCall: без title/rawInput,
  // только toolCallId + _meta.editableCommand с самой командой (замер 03.10.26).
  const editable = meta?.['cognition.ai/editableCommand'];
  if (typeof editable === 'string' && editable.trim()) {
    return editable.trim().split(/\s+/)[0];
  }
  const title = toolCall?.title;
  return (typeof title === 'string' && title.trim()) || 'Tool';
}

function readPermissionToolInput(toolCall) {
  const input = toolCall?.rawInput;
  if (input && typeof input === 'object' && Object.keys(input).length > 0) {
    return input;
  }
  const editable = toolCall?._meta?.['cognition.ai/editableCommand'];
  if (typeof editable === 'string' && editable.trim()) {
    return { command: editable.trim() };
  }
  return {};
}

/**
 * Выбор ACP-опции по решению человека (ProviderPermissionDecision):
 * «Allow & remember» → allow_always, «Allow once» → allow_once,
 * «Deny» → reject_once. Подходящей опции нет — «отмена» (агент получает
 * cancelled и сам решает, как объяснить отказ).
 */
function pickAcpPermissionOutcome(options, decision) {
  const allows = options.filter((option) => String(option?.kind || '').startsWith('allow_'));
  const rejects = options.filter((option) => String(option?.kind || '').startsWith('reject_'));

  if (decision?.allow) {
    const preferred = decision.rememberEntry ? 'allow_always' : 'allow_once';
    const pick = allows.find((option) => option?.kind === preferred) || allows[0];
    return pick
      ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  const pick = rejects.find((option) => option?.kind === 'reject_once') || rejects[0];
  return pick
    ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/**
 * Запрос `session/request_permission` от агента → человеку.
 *
 * Регистрирует ожидание в pendingPermissions (его забирает permission
 * gateway), шлёт `permission_request` в ленту и возвращает requestId.
 * Ответа у ACP нет по таймауту — агент ждёт, пока человек не решит
 * (задокументированное поведение: «висеть до ответа — ок»).
 */
function registerPermissionRequest({ request, sessionKey, respond, ws, appSessionId, reattached }) {
  const params = request.params || {};
  const toolCall = params.toolCall || {};
  const options = Array.isArray(params.options) ? params.options : [];
  const requestId = `devin-perm-${randomUUID()}`;

  const entry = {
    requestId,
    sessionKey,
    toolName: readPermissionToolName(toolCall),
    input: readPermissionToolInput(toolCall),
    options,
    receivedAt: new Date(),
    respond,
    reattached: Boolean(reattached),
  };
  pendingPermissions.set(requestId, entry);

  if (ws) {
    sendMessage(ws, createNormalizedMessage({
      provider: 'devin',
      sessionId: appSessionId,
      kind: 'permission_request',
      requestId,
      toolName: entry.toolName,
      input: entry.input,
      context: { options, toolCallId: toolCall?.toolCallId || null },
    }));
  }
  return entry;
}

/** Отменить незакрытые запросы конкретного хода/линка и снять баннер во вкладках. */
function cancelPendingPermissions(sessionKey, ws, appSessionId, { reattachedOnly = false, respondCancelled = true } = {}) {
  for (const [requestId, entry] of [...pendingPermissions]) {
    if (entry.sessionKey !== sessionKey) {
      continue;
    }
    if (reattachedOnly && !entry.reattached) {
      continue;
    }
    pendingPermissions.delete(requestId);
    if (respondCancelled) {
      try {
        entry.respond({ outcome: { outcome: 'cancelled' } });
      } catch {
        // процесс/сокет мёртв — отвечать некому
      }
    }
    if (ws) {
      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: appSessionId,
        kind: 'permission_cancelled',
        requestId,
        reason: 'run_finished',
      }));
    }
  }
}

/**
 * Ответ на ACP `session/request_permission` внутри живого хода.
 *
 * `bypass` — первый allow_* без человека (режим и так «не спрашивать»).
 * Остальные режимы — запрос уходит в UI (permission_request + gateway);
 * агент стоит, пока человек не ответит. Опций нет вовсе — отмена сразу.
 */
function answerPermissionRequest(request, devinMode, ws, sessionId, run, connection) {
  const params = request.params || {};
  const options = Array.isArray(params.options) ? params.options : [];

  if (devinMode === 'bypass') {
    const allow = options.find((option) => String(option?.kind || '').startsWith('allow_'));
    if (allow) {
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  if (options.length === 0) {
    return { outcome: { outcome: 'cancelled' } };
  }

  const sessionKey = run?.sessionKey || sessionId;
  registerPermissionRequest({
    request,
    sessionKey,
    respond: (result) => connection.respond(request.id, result),
    ws,
    appSessionId: sessionId,
    reattached: false,
  });
  // Ответ уйдёт позже через gateway — сейчас агент просто ждёт.
  return null;
}

/**
 * Тег ошибки, по которому ход переезжает на другую подписку: сбой случился
 * ДО первого живого вывода — в UI от этого хода ещё ничего не показано,
 * поэтому повтор честный (без дублей и потерь).
 */
const FAILOVER_TAG = '__devinFailover';
// Модель не приняла запрос (invalid_argument) до живого вывода — тот же ход повторяем на DEVIN_DEFAULT_MODEL
// той же подпиской, аккаунт не меняем (Егор 13.10.26: на adaptive ошибка, на High заработало).
const MODEL_FALLBACK_TAG = '__devinModelFallback';

/** Сколько всего попыток у хода: по одной на подписку, с запасом на будущие. */
const MAX_TURN_ATTEMPTS = 4;

/**
 * Runs one Devin turn over ACP — обёртка выбора линии и подписки.
 *
 * ЛИНИЯ (`sessions.devin_connection_id`) — каталог с sessions.db чата, она
 * не меняется никогда. ПОДПИСКА — креда, которая платит за этот ход:
 * выбранная в пикере → своя креда линии → первая годная
 * (`pickCredentialForLane`). Чужая подписка подаётся теневым XDG
 * (`prepareTurnDataHome`), поэтому чат продолжает свою историю под любой
 * подпиской. Новый чат: линией становится канал первой подписки, на которой
 * Devin выделил сессию.
 *
 * Фоллбэк: лимит/auth/сбой до первого живого вывода гасит подписку
 * (`recordOutcome`, cooldown до названного Devin времени сброса), и тот же
 * ход повторяется на следующей годной подписке на той же линии. Человек
 * видит строку «подписка X исчерпана — продолжаю на Y». После того как ответ
 * начал идти, повтора нет (иначе дубль). Попыток не больше MAX_TURN_ATTEMPTS.
 */
async function queryDevin(command, options = {}, ws, context) {
  const { sessionId } = options;
  // Подписка, выбранная человеком в пикере; нерабочая — молча уступает авто-выбору.
  const preferredConnectionId = Number(options.devinConnectionId) > 0 ? Number(options.devinConnectionId) : null;
  let providerSessionId = context.resolveProviderSessionId(sessionId);
  const boundConnectionId = sessionId
    ? (sessionsDb.getSessionById(sessionId)?.devin_connection_id ?? null)
    : null;
  // Наследие до Layer'а: resume-сессия без привязки — ищем канал, чья
  // sessions.db её хранит, иначе session/load уйдёт в чужую базу.
  const hostedConnectionId = boundConnectionId == null && providerSessionId
    ? (devinConnectionsService.findConnectionHostingSession(providerSessionId)?.id ?? null)
    : boundConnectionId;

  let lane = null;
  const attempted = [];
  let lastError = null;
  let turnOptions = options;
  for (let attempt = 0; attempt < MAX_TURN_ATTEMPTS; attempt++) {
    let connection;
    let dataHome;
    try {
      if (lane == null && hostedConnectionId != null) {
        lane = devinConnectionsService.resolveLaneForSession(hostedConnectionId);
      }
      connection = lane != null
        ? devinConnectionsService.pickCredentialForLane(lane, attempted, preferredConnectionId)
        : devinConnectionsService.pickConnection(attempted, preferredConnectionId);
      dataHome = devinConnectionsService.prepareTurnDataHome(lane ?? connection, connection);
    } catch (error) {
      // Каналов нет вовсе или все перепробованы — причину показываем, а не
      // молча заканчиваем ход.
      const failure = lastError ?? (error instanceof Error ? error : new Error(String(error)));
      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: sessionId || providerSessionId || null,
        kind: 'error',
        content: `Devin недоступен: ${failure.message}`,
      }));
      throw failure;
    }
    attempted.push(connection.id);

    try {
      await attemptDevinTurn(
        command, turnOptions, ws, context, { lane: lane ?? connection, credential: connection, dataHome },
        providerSessionId, attempt + 1 < MAX_TURN_ATTEMPTS,
      );
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      devinConnectionsService.recordOutcome(connection.id, 'failed', lastError.message);
      // Сбой после начала живого ответа повтор не лечит — ход заканчивается ошибкой.
      if (!lastError[FAILOVER_TAG] && !lastError[MODEL_FALLBACK_TAG]) {
        throw lastError;
      }
      // Новый чат успел получить сессию на этой линии — повтор продолжает её же,
      // под другой подпиской, а не заводит вторую.
      if (lastError.devinSessionId) {
        providerSessionId = lastError.devinSessionId;
        lane = lane ?? connection;
      }
      if (lastError[MODEL_FALLBACK_TAG]) {
        // Та же подписка, другая модель: подписка здорова, не считаем её «испробованной».
        attempted.pop();
        turnOptions = { ...turnOptions, forceModel: DEVIN_DEFAULT_MODEL };
        console.log(`[Devin] ход чата ${sessionId || '-'}: модель ${lastError.requestedModel || '?'} не приняла запрос — повтор на ${DEVIN_DEFAULT_MODEL}`);
        sendMessage(ws, createNormalizedMessage({
          provider: 'devin',
          sessionId: sessionId || null,
          kind: 'status',
          text: `Модель ${lastError.requestedModel || ''} не приняла запрос — повторяю на ${DEVIN_DEFAULT_MODEL}. Чтобы не терять время, выберите SWE-2 High в списке моделей.`,
        }));
        continue;
      }
      // Без имени подписки: строку видит и гость, а реестр подписок — только владелец.
      const reason = classifyDevinFailure(lastError.message) === 'rate_limit'
        ? 'У текущей подписки Devin исчерпан лимит'
        : 'Текущая подписка Devin не отвечает';
      console.log(`[Devin] ход чата ${sessionId || '-'}: подписка #${connection.id} (${connection.name}) — ${reason}, переход на другую (попытка заняла ${lastError.attemptMs ?? '?'}мс)`);
      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: sessionId || null,
        kind: 'status',
        text: `${reason} — продолжаю на другой подписке`,
      }));
    }
  }
  sendMessage(ws, createNormalizedMessage({
    provider: 'devin',
    sessionId: sessionId || providerSessionId || null,
    kind: 'error',
    content: `Devin недоступен: ${lastError?.message || 'no usable connection'}`,
  }));
  throw lastError ?? new Error('Devin run failed: no usable connection');
}

/**
 * Один ход через конкретный канал (`devin_connections` row).
 *
 * Devin's `acp` mode speaks JSON-RPC over stdio and handles one session at a
 * time, so each turn owns a fresh `devin acp` process: `session/load` revives
 * the persisted session when the chat already has a Devin id, otherwise
 * `session/new` allocates one and the id is reported to the writer.
 *
 * Contract with the registry (same as the other CLI runtimes):
 * - `session_created` exactly once for a fresh Devin session,
 * - normalized messages via `context.normalizeMessage(...)`,
 * - `writer.setSessionId(providerId)` as soon as the native id is known,
 * - exactly one terminal `complete` per turn — the registry drops duplicates
 *   emitted after an abort.
 */
async function attemptDevinTurn(command, options = {}, ws, context, route, providerSessionId, allowFailover = false) {
  // route.lane — где живёт sessions.db чата; route.credential — чья подписка
  // платит; route.dataHome — XDG_DATA_HOME процесса (линия или её тень).
  const { lane, credential: devinConn, dataHome } = route;
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    images,
    files,
    permissionMode = 'default',
  } = options;

  // Register the run BEFORE the async resolves: `chat.abort` can land while
  // resolveResumeModel is still awaiting — the run must already exist so
  // abort() marks it instead of racing past.
  const run = {
    child: null,
    connection: null,
    writer: ws,
    devinSessionId: providerSessionId || null,
    aborted: false,
    muted: false,
    sessionCreatedSent: Boolean(providerSessionId),
    terminalFailure: null,
    startedAt: Date.now(),
    // Замеры фаз запуска: spawn/init/session/firstOutput — в журнал на finish.
    timing: {},
    unregisterSurvivor: null,
    finishRun: null,
    failoverRequested: false,
    // Линия чата (Connection Layer): счётчик токенов читает sessions.db из её
    // каталога, не из машинного дефолта.
    lane,
    // Значения опции 'model' из configOptions сессии (Set<string>) и её
    // текущее значение — нужны, чтобы не отправлять set_config_option на
    // модель, которой у канала нет.
    modelOptions: null,
    modelCurrent: null,
    modelSetFailed: new Set(),
    modelDowngradeNotified: false,
    // Первый живой вывод хода (дельта, мысль, запрос разрешения) ушёл в UI.
    liveOutputSent: false,
  };
  // Повтор на другой подписке честен, пока человек не увидел ни строчки
  // этого хода: лимит Devin отвечает ошибкой на session/prompt сразу, до
  // вывода. Сессия при этом уже может существовать — она в линии, и
  // следующая попытка её загрузит.
  const canFailoverNow = () => allowFailover && !run.aborted && !run.liveOutputSent && !run.failoverRequested;
  // Фаза запуска отмечается один раз — первый вызов побеждает.
  const markPhase = (name) => { if (run.timing[name] === undefined) run.timing[name] = Date.now(); };
  const noteLiveOutput = () => { if (!run.liveOutputSent) { run.liveOutputSent = true; markPhase('firstOutput'); } };
  const sessionKey = sessionId || providerSessionId;
  run.sessionKey = sessionKey;
  if (sessionKey) {
    activeDevinRuns.set(sessionKey, run);
  }

  // Каталог разрешён почти весь (Егор 13.10.26), отклоняются только fusion-*/MODEL_* —
  // старый чат или ручной запрос с такой моделью идёт на модели по умолчанию.
  const requestedModel = options.forceModel || await context.resolveResumeModel(sessionId, model);
  // Пустая модель тоже заменяется: иначе Devin взял бы модель из своего конфига, а защита держалась бы на внешнем файле.
  const resolvedModel = !requestedModel || !isAllowedDevinModel(requestedModel) ? DEVIN_DEFAULT_MODEL : requestedModel;
  run.resolvedModel = resolvedModel;
  if (resolvedModel !== requestedModel) {
    console.warn(`[Devin] model "${requestedModel}" is not in the allowed catalog — running ${DEVIN_DEFAULT_MODEL}`);
  }
  // Команды Devin, меняющие модель изнутри чата ("/model opus", "/fusion", "/adaptive"), обошли бы
  // выбор модели из пикера — до запуска агента такой ход отклоняем.
  if (/^\s*\/(model|fusion|adaptive)\b/i.test(String(command ?? ''))) {
    if (sessionKey) {
      activeDevinRuns.delete(sessionKey);
    }
    sendMessage(ws, createNormalizedMessage({
      provider: 'devin',
      sessionId: sessionId || null,
      kind: 'error',
      content: 'Смена модели Devin командой запрещена — выберите модель в списке моделей чата.',
    }));
    sendMessage(ws, createCompleteMessage({
      provider: 'devin',
      sessionId: sessionId || null,
      exitCode: 1,
      aborted: false,
    }));
    return;
  }
  const workingDirectory = cwd || projectPath || process.cwd();
  const devinMode = mapPermissionModeToDevinMode(permissionMode);

  // XDG_DATA_HOME = линия чата (своя креда) или её тень с кредой подписки.
  const childEnv = buildDevinChildEnv(dataHome);

  // `devin --permission-mode dangerous acp`: the flag is a top-level option
  // (dangerous = alias of bypass), accepted before the subcommand. It covers
  // the window between spawn and `session/set_mode`, when the agent could
  // already raise a permission request. The acp subcommand reads neither
  // --permission-mode nor DEVIN_PERMISSION_MODE.
  const args = [
    ...(permissionMode === 'bypassPermissions' ? ['--permission-mode', 'dangerous'] : []),
    'acp',
  ];
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }

  // Агент поднимается под супервизором (devin-acp-supervisor): stdin держит
  // он, поэтому ход переживает перезапуск сервера — новый сервер находит
  // сокет по записи live-runs и продолжает отвечать на запросы агента.
  // Супервизор не поднялся — обычный spawn: ход работает, просто не
  // переживёт рестарт (поведение первой фазы).
  const devinCommand = resolveDevinCliCommand();
  let child;
  try {
    child = await spawnSupervisedDevin({
      command: devinCommand,
      args,
      cwd: workingDirectory,
      env: childEnv,
      appSessionId: sessionKey || null,
    });
  } catch (supervisorError) {
    console.warn('[Devin] supervisor unavailable, direct spawn:', supervisorError?.message || supervisorError);
    // Запасной прямой запуск — тоже в своей комнате, иначе агент сидит в группе сайта.
    const room = wrapInAgentRoom(devinCommand, args, childEnv, sessionKey);
    child = spawn(room.command, room.args, {
      cwd: workingDirectory,
      env: room.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  run.child = child;
  markPhase('spawn');

  // Without an 'error' listener a spawn ENOENT (no devin CLI on PATH) is an
  // uncaughtException — it previously took the whole server down per send.
  const spawnError = { error: null };
  child.once('error', (error) => {
    spawnError.error = error;
  });

  // Aborted while the model was still resolving: kill the just-spawned child
  // and let the connect path fall out via the aborted branch.
  if (run.aborted) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  // The agent survives a site restart: the record lets the next server adopt
  // this process and keep the chat marked busy (survivor-runs.js). Сокет
  // супервизора в записи — чтобы новый сервер переподключился к живому ходу.
  run.unregisterSurvivor = registerProviderRun(child, {
    provider: 'devin',
    appSessionId: sessionKey || null,
    providerSessionId: providerSessionId || null,
    extra: {
      socketPath: child.socketPath || null,
      runId: child.runId || null,
      supervisorPid: child.supervisorPid || null,
      // Линия, чья sessions.db трогает этот ход — новый сервер читает прогресс
      // из базы линии, а не из машинного дефолта (survivorProgressStamp).
      devinDataHome: lane.xdg_data_home || null,
    },
  });

  const finish = (exitCode, aborted) => {
    if (run.finishRun) {
      return; // exactly one `complete` per turn
    }
    run.finishRun = true;
    // Хронометраж запуска одной строкой: видно, где тонет «Запускаю чат» —
    // поднятие процесса, рукопожатие, загрузка беседы или ожидание первого вывода.
    const rel = (name) => (run.timing[name] != null ? `${run.timing[name] - run.startedAt}мс` : '-');
    console.log(`[Devin] timing чат ${sessionId || '-'}: spawn=${rel('spawn')} init=${rel('init')} session=${rel('session')} first=${rel('firstOutput')} total=${Date.now() - run.startedAt}мс exit=${exitCode}`);
    if (!aborted) {
      devinConnectionsService.recordOutcome(
        devinConn.id,
        exitCode === 0 ? 'ok' : 'failed',
        run.lastErrorDetail,
      );
    }

    // Ход кончился — висящие запросы разрешений гасим, чтобы баннеры во
    // вкладках не остались навсегда, а агент (если жив) получил cancelled.
    cancelPendingPermissions(sessionKey, ws, sessionId || run.devinSessionId);

    if (run.unregisterSurvivor) {
      run.unregisterSurvivor();
      run.unregisterSurvivor = null;
    }

    if (run.usageTimer) {
      clearInterval(run.usageTimer);
      run.usageTimer = null;
    }

    if (sessionKey) {
      activeDevinRuns.delete(sessionKey);
    }

    try {
      child.kill('SIGTERM');
      const finishKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, ABORT_GRACE_MS);
      finishKill.unref?.();
    } catch {
      // Already gone.
    }

    // Процесс пережил и «остановить»: канал к супервизору был мёртв, и агент
    // работает дальше сам по себе (ход реестр счёл завершённым, а его ещё
    // идёт). Запись live-runs заново — она описывает именно такого сироту:
    // следующий сервер его усыновит (adoptSurvivors → reattachSurvivor), а
    // пока он держит замок беседы — новые ходы на неё ждут (см. session/load).
    const orphanCheck = setTimeout(() => {
      if (!child?.pid || !isDevinPidAlive(child.pid)) {
        return;
      }
      try {
        registerProviderRun(child, {
          provider: 'devin',
          appSessionId: sessionKey || null,
          providerSessionId: run.devinSessionId || providerSessionId || null,
          extra: {
            socketPath: child.socketPath || null,
            runId: child.runId || null,
            supervisorPid: child.supervisorPid || null,
            devinDataHome: lane.xdg_data_home || null,
          },
        });
        console.warn(`[Devin] процесс ${child.pid} пережил конец хода — оставил живую запись для усыновления (чат ${sessionKey || '?'})`);
      } catch (error) {
        console.warn('[Devin] не удалось вернуть запись о сироте:', error?.message || error);
      }
    }, ABORT_GRACE_MS + LOCK_HOLDER_POLL_MS);
    orphanCheck.unref?.();

    sendMessage(ws, createCompleteMessage({
      provider: 'devin',
      sessionId: run.devinSessionId || sessionId || null,
      exitCode,
      aborted,
    }));
  };

  // Уборка неудачной попытки без `complete` в UI: ход продолжается на другом
  // канале, и сказать «закончилось» было бы ложью.
  const silentCleanup = () => {
    if (sessionKey) {
      activeDevinRuns.delete(sessionKey);
    }
    cancelPendingPermissions(sessionKey, ws, sessionId || run.devinSessionId);
    if (run.unregisterSurvivor) {
      run.unregisterSurvivor();
      run.unregisterSurvivor = null;
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  };

  return await new Promise((resolve, reject) => {
    const requestFailover = (message, tag = FAILOVER_TAG) => {
      run.failoverRequested = true;
      // Поздний onClose убитого процесса обязан молчать: complete хода теперь
      // принадлежит следующей попытке на другом канале.
      run.finishRun = true;
      silentCleanup();
      const error = new Error(message);
      error[tag] = true;
      error.requestedModel = resolvedModel;
      // Сколько заняла неудачная попытка — в журнале видно цену перебора подписок.
      error.attemptMs = Date.now() - run.startedAt;
      // Сессия, которую Devin успел выделить на линии: повтор её загрузит.
      error.devinSessionId = run.devinSessionId || null;
      reject(error);
    };

    const hardFail = (message, extra = {}) => {
      run.lastErrorDetail = message;
      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: run.devinSessionId || sessionId || null,
        kind: 'error',
        content: message,
        ...extra,
      }));
      finish(1, false);
      reject(new Error(message));
    };

    const connection = createAcpConnection(child, {
      onNotification: (msg) => {
        if (msg.method !== 'session/update') {
          return; // _cognition.ai/* and other control traffic: ignore
        }
        const params = msg.params || {};
        const update = params.update || {};
        // Список доступных каналу моделей приходит и событием (после
        // session/set_config_option) — держим его свежим.
        if (update.sessionUpdate === 'config_option_update') {
          noteConfigOptions(run, update.configOptions);
        }
        // Накапливаем текст текущего ответа для защиты от тихого обрывания
        // после статусных блоков (см. isIncompleteDevinResponse).
        if (update.sessionUpdate === 'agent_message_chunk') {
          const chunkBlock = update.content;
          const text = chunkBlock && typeof chunkBlock.text === 'string' ? chunkBlock.text : '';
          if (text) {
            run.turnAssistantText = (run.turnAssistantText || '') + text;
          }
        }
        if (update.sessionUpdate === 'tool_call') {
          run.turnHasToolCalls = true;
        }
        if (run.muted) {
          return; // session/load replays history — never leak it as live deltas
        }
        const normalized = context.normalizeMessage(params.update ?? params, sessionId || run.devinSessionId || null);
        for (const message of normalized) {
          noteLiveOutput();
          sendMessage(ws, message);
        }
      },

      onRequest: (msg) => {
        if (msg.method === 'session/request_permission') {
          noteLiveOutput();
          const result = answerPermissionRequest(msg, devinMode, ws, sessionId || run.devinSessionId, run, connection);
          if (result) {
            connection.respond(msg.id, result);
          }
          return;
        }
        // fs/*, terminal/*, unknown agent requests: politely decline so the
        // agent never hangs waiting for an answer.
        connection.respondError(msg.id, -32601, `cc2 does not implement ${msg.method}`);
      },

      onClose: () => {
        if (run.finishRun) {
          return;
        }
        const tail = connection.getStderrTail();
        run.lastErrorDetail = tail?.trim().split('\n').pop() || null;
        const message = run.aborted
          ? 'Devin run aborted'
          : `Devin exited before finishing the turn${tail ? `: ${tail.trim().split('\n').pop()}` : ''}`;
        // Канал умер до выделения сессии (типично: отозванная креда — CLI
        // печатает 'Authentication required' и выходит) — отдаём ход другому.
        if (canFailoverNow() && isFailoverableFailure(classifyDevinFailure(message))) {
          requestFailover(message);
          return;
        }
        if (!run.aborted) {
          notifyRunFailed({
            userId: ws?.userId || null,
            provider: 'devin',
            sessionId: sessionId || run.devinSessionId || null,
            error: message,
            sessionName: sessionSummary,
          });
        }
        finish(run.aborted ? 0 : 1, run.aborted);
        resolve();
      },
    });
    run.connection = connection;

    (async () => {
      await connection.call('initialize', {
        protocolVersion: 1,
        // Deliberately empty: no fs/terminal client capabilities — Devin then
        // uses its own tools instead of routing calls back through us.
        clientCapabilities: {},
        clientInfo: { name: 'cc2-claude-ui', version: '1.0.0' },
      }, HANDSHAKE_TIMEOUT_MS);
      markPhase('init');

      if (spawnError.error) {
        throw spawnError.error;
      }

      let loaded = false;
      if (providerSessionId) {
        run.muted = true;
        try {
          // session_locked (10.10.26 зомби, 11.10.26 живой держатель):
          // - замок мёртвого процесса — пауза и повтор, как раньше;
          // - замок ЖИВОГО `devin acp` — не ошибка, а «чат занят»: реестр
          //   потерял чужой ход (канал к его супервизору оборвался), и красная
          //   ошибка + потеря сообщения сыпались на каждую отправку. Ждём
          //   конца держателя (он пишет в ту же sessions.db) и грузим сессию —
          //   для человека это обычная очередь «ответ → следующее сообщение».
          let lockWaitNotified = false;
          let zombieRetries = 0;
          const lockWaitDeadline = Date.now() + LOCK_HOLDER_WAIT_MS;
          for (;;) {
            try {
              const loadResult = await connection.call('session/load', {
                sessionId: providerSessionId,
                cwd: workingDirectory,
                mcpServers: [],
              }, HANDSHAKE_TIMEOUT_MS);
              noteConfigOptions(run, loadResult?.configOptions);
              break;
            } catch (loadError) {
              const retryable = loadError?.data?.['cognition.ai/retryable'] === true
                && loadError?.data?.['cognition.ai/errorKind'] === 'session_locked';
              if (!retryable) {
                throw loadError;
              }
              const holderPid = Number(loadError?.data?.['cognition.ai/lockHolderPid']) || null;
              if (holderPid && isDevinPidAlive(holderPid) && !run.aborted && Date.now() < lockWaitDeadline) {
                if (!lockWaitNotified) {
                  lockWaitNotified = true;
                  console.warn(`[Devin] беседу ${providerSessionId} держит живой процесс ${holderPid} — жду конца его хода`);
                  sendMessage(ws, createNormalizedMessage({
                    provider: 'devin',
                    sessionId: sessionId || run.devinSessionId || null,
                    kind: 'status',
                    text: 'Прошлый ответ в этом чате ещё дописывается — сообщение отправлю, как только он завершится.',
                  }));
                }
                await new Promise((r) => setTimeout(r, LOCK_HOLDER_POLL_MS));
                continue;
              }
              if (run.aborted || Date.now() > lockWaitDeadline || zombieRetries >= LOCK_ZOMBIE_RETRIES) {
                throw loadError;
              }
              zombieRetries += 1;
              console.warn(`[Devin] беседа ${providerSessionId} под замком — повтор session/load через 3 с`);
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
          // Наследие без привязки (чаты до Connection Layer) прибивается к
          // линии, из чьей sessions.db оно реально поднялось.
          if (sessionId && sessionsDb.getSessionById(sessionId)?.devin_connection_id == null) {
            sessionsDb.setSessionDevinConnection(sessionId, lane.id);
          }
          loaded = true;
        } catch (error) {
          // Беседы с таким номером у Devin нет — продолжать нечего, истории
          // тоже. Начинаем новую вместо ошибки (04.10.26: чат с ложным номером
          // отвечал «Session not found» на каждое сообщение и был мёртв).
          if (error?.data?.['cognition.ai/errorKind'] !== 'session_not_found') {
            throw error;
          }
          console.warn(`[Devin] беседы ${providerSessionId} нет у Devin — начинаю новую`);
          run.devinSessionId = null;
          run.sessionCreatedSent = false;
        } finally {
          run.muted = false;
        }
      }
      if (!loaded) {
        const created = await connection.call('session/new', {
          cwd: workingDirectory,
          mcpServers: [],
        }, HANDSHAKE_TIMEOUT_MS);
        noteConfigOptions(run, created?.configOptions);

        const newId = created?.sessionId;
        if (newId) {
          // Чат прибивается к ЛИНИИ в момент выделения сессии: его sessions.db
          // живёт в её каталоге; платить за ходы дальше может любая подписка.
          if (sessionId) {
            sessionsDb.setSessionDevinConnection(sessionId, lane.id);
          }
          run.devinSessionId = newId;
          if (typeof ws.setSessionId === 'function') {
            ws.setSessionId(newId);
          }
          // The survivor record can now point at the real Devin session.
          noteSurvivorProviderSession(sessionKey, newId);
          if (!run.sessionCreatedSent) {
            run.sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({
              provider: 'devin',
              sessionId: newId,
              kind: 'session_created',
              newSessionId: newId,
            }));
          }
        }
      }

      markPhase('session');
      if (devinMode) {
        try {
          await connection.call('session/set_mode', {
            sessionId: run.devinSessionId,
            modeId: devinMode,
          }, HANDSHAKE_TIMEOUT_MS);
        } catch (error) {
          console.warn(`[Devin] session/set_mode "${devinMode}" failed:`, error.message);
        }
      }

      if (resolvedModel) {
        // `--model` only covers fresh sessions; a loaded session keeps its
        // stored model unless we set the config option explicitly.
        // The option list is the channel's truth: a model the picker offered
        // but the channel doesn't have would fail with Invalid params on
        // every turn and silently run the old model — so it's skipped and
        // named honestly, once per run.
        const knownUnavailable = run.modelOptions instanceof Set && !run.modelOptions.has(resolvedModel);
        const notifyDowngrade = () => {
          if (run.modelDowngradeNotified) return;
          run.modelDowngradeNotified = true;
          const effective = run.modelCurrent || DEVIN_DEFAULT_MODEL;
          console.warn(`[Devin] model "${resolvedModel}" is not in this channel's options — running ${effective}`);
          sendMessage(ws, createNormalizedMessage({
            provider: 'devin',
            sessionId: sessionId || run.devinSessionId || null,
            kind: 'error',
            content: `Модель «${resolvedModel}» недоступна на активном канале Devin — ход идёт на ${effective}.`,
          }));
        };
        if (knownUnavailable || run.modelSetFailed.has(resolvedModel)) {
          notifyDowngrade();
        } else {
          try {
            await connection.call('session/set_config_option', {
              sessionId: run.devinSessionId,
              configId: 'model',
              value: resolvedModel,
            }, HANDSHAKE_TIMEOUT_MS);
          } catch (error) {
            // «Слепой» путь (configOptions не пришли): отказ — та же тихая
            // подмена; говорим честно один раз.
            run.modelSetFailed.add(resolvedModel);
            console.warn('[Devin] session/set_config_option model failed:', error.message);
            notifyDowngrade();
          }
        }
      }

      // Attachments ride along as path references (the same <images_input> /
      // <files_input> contract Cursor and OpenCode use): the Devin agent reads
      // them with its own filesystem tools.
      let promptText = appendFilesInputTag(appendImagesInputTag(command, images), files);

      // Пока ход идёт, счётчик читается из sessions.db — Devin пишет туда
      // metrics каждого ответа по ходу работы (см. devin-usage.ts).
      run.usageTimer = setInterval(() => emitDevinTokenBudget(ws, run, sessionId), DEVIN_USAGE_POLL_MS);
      run.usageTimer.unref?.();

      // Запрос у модели — подпись плашки меняется с «Запускаю чат» на
      // «Думает» сразу, а не когда придёт первый токен (у Claude провайдера
      // тот же кадр 'requesting' шлётся при отправке).
      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: sessionId || run.devinSessionId || null,
        kind: 'run_phase',
        text: 'thinking',
      }));

      const MAX_CONTINUATIONS = 2;
      let continuationCount = 0;
      let result;
      while (continuationCount <= MAX_CONTINUATIONS) {
        const promptResult = connection.call('session/prompt', {
          sessionId: run.devinSessionId,
          prompt: [{ type: 'text', text: promptText }],
        });
        // Кадр prompt уже записан в сокет супервизора: с этого момента ход
        // переживает перезапуск сайта (promptInFlight не даёт супервизору убрать
        // агента, новый сервер переподключится и дочитает ответ).
        options.onPromptAnchored?.();
        result = await promptResult;

        const stopReason = result?.stopReason;
        const needContinue = stopReason === 'end_turn'
          && continuationCount < MAX_CONTINUATIONS
          && isIncompleteDevinResponse(run.turnAssistantText, run.turnHasToolCalls);

        if (!needContinue) {
          break;
        }

        continuationCount += 1;
        sendMessage(ws, createNormalizedMessage({
          provider: 'devin',
          sessionId: run.devinSessionId || sessionId || null,
          kind: 'status',
          text: 'turn_continued',
          content: `Ход завершился без ответа (только статусный блок). Продолжаю автоматически (попытка ${continuationCount}/${MAX_CONTINUATIONS}).`,
        }));
        // Сбрасываем аккумуляторы для следующего витка.
        run.turnAssistantText = '';
        run.turnHasToolCalls = false;
        promptText = 'Продолжи работу с того места, где остановился, и доведи до финального ответа. Не пиши заново блок «Как я понял задачу»; сразу делай следующий шаг и выдай результат, уточняющий вопрос или явное сообщение об ошибке.';
      }

      if (run.usageTimer) {
        clearInterval(run.usageTimer);
        run.usageTimer = null;
      }

      if (run.aborted) {
        finish(0, true);
        resolve();
        return;
      }

      const stopReason = result?.stopReason;
      // Если после попыток продолжения ответ всё ещё не финальный — показываем
      // человеку явную ошибку вместо тихого завершения.
      if (stopReason === 'end_turn' && isIncompleteDevinResponse(run.turnAssistantText, run.turnHasToolCalls)) {
        sendMessage(ws, createNormalizedMessage({
          provider: 'devin',
          sessionId: run.devinSessionId || sessionId || null,
          kind: 'error',
          content: 'Ход завершился без финального ответа: модель остановилась на статусном блоке. Попробуйте повторить запрос или продолжить чат командой «Продолжай».'
        }));
      }

      // Финальный замер — последний ответ мог дописаться в базу только что.
      emitDevinTokenBudget(ws, run, sessionId, { force: true });
      const usage = result?.usage;
      if (usage) {
        sendMessage(ws, createNormalizedMessage({
          provider: 'devin',
          sessionId: run.devinSessionId || sessionId || null,
          kind: 'status',
          text: 'token_budget',
          tokenBudget: {
            used: usage.totalTokens ?? 0,
            total: usage.totalTokens ?? 0,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            breakdown: {
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
            },
          },
        }));
      }

      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: run.devinSessionId || sessionId || null,
        kind: 'stream_end',
      }));

      if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'devin',
          sessionId: sessionId || run.devinSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
      }

      finish(stopReason === 'end_turn' || stopReason === 'max_tokens' ? 0 : 1, stopReason === 'cancelled');
      resolve();
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (run.aborted) {
        finish(0, true);
        resolve();
        return;
      }
      if (run.finishRun) {
        // Process died mid-call: onClose already emitted the terminal state —
        // a second error frame after `complete` would just confuse the UI.
        resolve();
        return;
      }
      const tail = connection.getStderrTail();
      const detail = tail && !message.includes(tail.trim().split('\n').pop() || '')
        ? `${message} — ${tail.trim().split('\n').pop()}`
        : message;
      const failureClass = classifyDevinFailure(detail);
      if (failureClass === 'model' && !run.failoverRequested && canFailoverNow() && resolvedModel !== DEVIN_DEFAULT_MODEL) {
        requestFailover(detail, MODEL_FALLBACK_TAG);
        return;
      }
      if (!run.failoverRequested && canFailoverNow() && isFailoverableFailure(failureClass)) {
        requestFailover(detail);
        return;
      }
      if (failureClass === 'session_locked') {
        // Сессию держит живой процесс прошлого хода этого чата — подписки ни при чём.
        const holderPid = /\(PID (\d+)\)/.exec(detail)?.[1];
        console.warn(`[Devin] чат ${sessionId || '-'}: сессия ${run.devinSessionId || providerSessionId} занята процессом ${holderPid || '?'}`);
        // Исходный текст — в учёт исхода (recordOutcome узнаёт session_locked и
        // подписку не штрафует); человеку — что делать.
        run.lastErrorDetail = detail;
        sendMessage(ws, createNormalizedMessage({
          provider: 'devin',
          sessionId: run.devinSessionId || sessionId || null,
          kind: 'error',
          content: 'Этот чат ещё занят: предыдущий ход Devin не завершился. Подождите, пока он закончит, и отправьте сообщение снова.',
        }));
        finish(1, false);
        reject(new Error(detail));
        return;
      }
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'devin',
        sessionId: sessionId || run.devinSessionId || null,
        error: detail,
        sessionName: sessionSummary,
      });
      const brief = detail.replace(/\s+/g, ' ').split(/(?<=\.)\s/)[0].slice(0, 160);
      hardFail(`Devin run failed: ${brief}`);
    });
  });
}

export const devinRuntime = {
  run: (command, options, writer, context) => queryDevin(command, options, writer, context),

  /**
   * Cancels the live turn: asks the agent to stop over ACP, then kills the
   * process if it is still around after a short grace period. The registry
   * emits the terminal `complete` itself for aborted runs.
   */
  abort(sessionId) {
    const run = activeDevinRuns.get(sessionId);
    if (!run) {
      return false;
    }

    run.aborted = true;
    // Человек нажал «стоп» — ждущие разрешения отменяем сразу, не дожидаясь
    // конца grace-периода: баннер исчезает, агент получает cancelled.
    cancelPendingPermissions(sessionId, run.writer, sessionId || run.devinSessionId);
    if (run.devinSessionId && run.connection) {
      run.connection.notify('session/cancel', { sessionId: run.devinSessionId });
    }

    const child = run.child;
    if (child) {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, ABORT_GRACE_MS);
      timer.unref?.();
    }

    return true;
  },

  /**
   * Permission gateway: `chat.permission-response` из UI приходит сюда через
   * providerRuntimeService, `chat.subscribe` забирает ожидающие listPending'ом.
   */
  permissions: {
    resolve(requestId, decision) {
      const entry = pendingPermissions.get(requestId);
      if (!entry) {
        return;
      }
      pendingPermissions.delete(requestId);
      try {
        entry.respond(pickAcpPermissionOutcome(entry.options, decision));
      } catch {
        // агент/сокет уже мёртв — отвечать некому
      }
      // Ответ ушёл — у переподключённого линка больше может не быть
      // незакрытых запросов: если prompt уже кончился, линк ни к чему.
      maybeReleaseReattach(entry.sessionKey);
    },
    listPending(sessionId) {
      const pending = [];
      for (const entry of pendingPermissions.values()) {
        if (entry.sessionKey === sessionId) {
          pending.push({
            requestId: entry.requestId,
            toolName: entry.toolName,
            input: entry.input,
            context: { options: entry.options },
            sessionId,
            receivedAt: entry.receivedAt,
          });
        }
      }
      return pending;
    },
  },

  /**
   * Переподключение к ходу, пережившему рестарт сервера (survivor-запись с
   * socketPath супервизора). Поднимает незакрытые запросы агента — в первую
   * очередь session/request_permission — обратно в pendingPermissions, чтобы
   * человек мог ответить уже из нового сервера. `emit` — рассылка живого
   * permission_request подписанным вкладкам (запросы, пришедшие после
   * переподключения).
   */
  reattachSurvivor(record, emit) {
    void reattachDevinSurvivor(record, emit).catch((error) => {
      console.warn('[Devin] reattach survivor failed:', error?.message || error);
    });
  },
};

/**
 * Если у переподключённого чата не осталось незакрытых запросов и prompt уже
 * завершён — линк закрываем: супервизор по отключению без prompt'а уберёт
 * простаивающего агента (то же, что делает конец хода).
 */
function maybeReleaseReattach(sessionKey) {
  const state = sessionKey ? reattachedDevinSurvivors.get(sessionKey) : null;
  if (!state || !state.link || state.closed) {
    return;
  }
  const stillPending = [...pendingPermissions.values()].some((entry) => entry.sessionKey === sessionKey);
  if (!stillPending && !state.link.promptInFlight) {
    closeReattach(state);
  }
}

function closeReattach(state) {
  if (state.closed) {
    return;
  }
  state.closed = true;
  reattachedDevinSurvivors.delete(state.sessionKey);
  try {
    state.link?.close();
  } catch {
    // уже закрыт
  }
}

/**
 * Само переподключение: супервизор повторяет неотвеченные запросы агента
 * ({c:'req'}) и дальше шлёт новые строки stdout ({c:'out'}). На каждый
 * session/request_permission — запись в pendingPermissions + живое событие
 * через emit; прочим запросам агента — вежливый отказ, как в ходе.
 * Линк живёт до конца prompt'а (turn_end/exit) — новые запросы могут
 * прийти в любой момент идущего хода.
 */
async function reattachDevinSurvivor(record, emit) {
  const sessionKey = record?.appSessionId;
  const socketPath = record?.socketPath;
  if (!sessionKey || !socketPath || reattachedDevinSurvivors.has(sessionKey)) {
    return;
  }

  const state = {
    sessionKey,
    link: null,
    closed: false,
    seenAcpRequestIds: new Set(),
  };
  reattachedDevinSurvivors.set(sessionKey, state);

  let link;
  try {
    link = await connectSupervisedDevin({
    socketPath,
    onLine(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg || msg.method === undefined || msg.id === undefined) {
        return; // ответы и уведомления — не наше дело, история в sessions.db
      }
      if (state.seenAcpRequestIds.has(msg.id)) {
        return;
      }
      state.seenAcpRequestIds.add(msg.id);

      if (msg.method === 'session/request_permission') {
        const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
        const entry = registerPermissionRequest({
          request: msg,
          sessionKey,
          respond: (result) => link.writeLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })),
          ws: null,
          appSessionId: sessionKey,
          reattached: true,
        });
        // Живой баннер для уже открытой вкладки (subscribe отдаст pending
        // только при следующей подписке).
        if (typeof emit === 'function' && options.length > 0) {
          try {
            emit(createNormalizedMessage({
              provider: 'devin',
              sessionId: sessionKey,
              kind: 'permission_request',
              requestId: entry.requestId,
              toolName: entry.toolName,
              input: entry.input,
              context: { options },
            }));
          } catch {
            // рассылка не удалась — запрос всё равно виден по listPending
          }
        }
        return;
      }
      // fs/*, terminal/*, неизвестные запросы агента — вежливый отказ.
      link.writeLine(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `cc2 does not implement ${msg.method}` },
      }));
    },
    onTurnEnd() {
      // Ход кончился: незакрытые запросы гасим и отпускаем агента — по
      // отключении без prompt'а супервизор его уберёт.
      cancelPendingPermissions(sessionKey, null, sessionKey, { reattachedOnly: true });
      closeReattach(state);
    },
    onExit() {
      cancelPendingPermissions(sessionKey, null, sessionKey, { reattachedOnly: true, respondCancelled: false });
      closeReattach(state);
    },
    onClose() {
      cancelPendingPermissions(sessionKey, null, sessionKey, { reattachedOnly: true, respondCancelled: false });
      closeReattach(state);
    },
    });
  } catch (error) {
    // Сокет не открылся — супервизор мёртв, запись протухла. Убрать отметку,
    // иначе повторная попытка никогда не случится.
    reattachedDevinSurvivors.delete(sessionKey);
    throw error;
  }
  state.link = link;

  // Если в момент подключения ни prompt'а, ни незакрытых запросов — линк не
  // нужен: простаивающего агента супервизор уберёт по нашему отключению.
  const hasPending = [...pendingPermissions.values()].some((entry) => entry.sessionKey === sessionKey);
  if (!hasPending && !link.promptInFlight) {
    closeReattach(state);
  }
}
