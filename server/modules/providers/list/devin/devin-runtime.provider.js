import { spawn } from 'node:child_process';

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
  buildDevinChildEnv,
  createCompleteMessage,
  createNormalizedMessage,
  resolveDevinCliCommand,
} from '@/shared/utils.js';
import { mapPermissionModeToDevinMode } from '@/modules/providers/list/devin/devin-sessions.provider.js';

/**
 * Live Devin ACP processes keyed by the app-facing session id.
 *
 * `abort()` looks a run up here; the entry also carries the flags the stream
 * loop needs (`aborted` suppresses the runtime's own `complete` — the abort
 * handler has already emitted one).
 */
const activeDevinRuns = new Map();

/** How long `abort` lets Devin wind down before SIGKILLing it. */
const ABORT_GRACE_MS = 3_000;
/** initialize/session/new must answer promptly; a hung handshake = broken CLI. */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** Devin logs progress to stderr (INFO lines) — keep the tail for error text. */
const STDERR_TAIL_BYTES = 4_000;

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
 * Answers an ACP `session/request_permission` request without a human.
 *
 * There is no permission UI for Devin chats yet: `bypass` picks the first
 * allow_* option; every other mode declines so nothing dangerous runs
 * unattended. A declined request surfaces in the chat as a tool error.
 */
function answerPermissionRequest(request, devinMode, ws, sessionId) {
  const params = request.params || {};
  const toolCall = params.toolCall || {};
  const options = Array.isArray(params.options) ? params.options : [];
  const allow = options.find((option) => String(option?.kind || '').startsWith('allow_'));
  const reject = options.find((option) => String(option?.kind || '').startsWith('reject_'));

  if (devinMode === 'bypass' && allow) {
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  }

  if (reject) {
    sendMessage(ws, createNormalizedMessage({
      provider: 'devin',
      sessionId,
      kind: 'tool_use',
      toolName: toolCall.title || 'Tool',
      toolId: toolCall.toolCallId || undefined,
      toolInput: toolCall.rawInput ?? {},
      toolResult: {
        content: `Permission declined automatically (Devin session mode "${devinMode || 'default'}"). Switch permission mode to bypass to allow.`,
        isError: true,
      },
    }));
    return { outcome: { outcome: 'selected', optionId: reject.optionId } };
  }

  return { outcome: { outcome: 'cancelled' } };
}

/**
 * Runs one Devin turn over ACP.
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
async function queryDevin(command, options = {}, ws, context) {
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

  const providerSessionId = context.resolveProviderSessionId(sessionId);

  // Register the run BEFORE the async resolves: `chat.abort` can land while
  // resolveResumeModel is still awaiting — the run must already exist so
  // abort() marks it instead of racing past.
  const run = {
    child: null,
    connection: null,
    devinSessionId: providerSessionId || null,
    aborted: false,
    muted: false,
    sessionCreatedSent: Boolean(providerSessionId),
    terminalFailure: null,
    startedAt: Date.now(),
    unregisterSurvivor: null,
    finishRun: null,
  };
  const sessionKey = sessionId || providerSessionId;
  if (sessionKey) {
    activeDevinRuns.set(sessionKey, run);
  }

  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  const workingDirectory = cwd || projectPath || process.cwd();
  const devinMode = mapPermissionModeToDevinMode(permissionMode);

  const childEnv = buildDevinChildEnv();

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

  const child = spawn(resolveDevinCliCommand(), args, {
    cwd: workingDirectory,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  run.child = child;

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
  // this process and keep the chat marked busy (survivor-runs.js).
  run.unregisterSurvivor = registerProviderRun(child, {
    provider: 'devin',
    appSessionId: sessionKey || null,
    providerSessionId: providerSessionId || null,
  });

  const finish = (exitCode, aborted) => {
    if (run.finishRun) {
      return; // exactly one `complete` per turn
    }
    run.finishRun = true;

    if (run.unregisterSurvivor) {
      run.unregisterSurvivor();
      run.unregisterSurvivor = null;
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

    sendMessage(ws, createCompleteMessage({
      provider: 'devin',
      sessionId: run.devinSessionId || sessionId || null,
      exitCode,
      aborted,
    }));
  };

  return await new Promise((resolve, reject) => {
    const hardFail = (message, extra = {}) => {
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
        if (run.muted) {
          return; // session/load replays history — never leak it as live deltas
        }
        const normalized = context.normalizeMessage(params.update ?? params, sessionId || run.devinSessionId || null);
        for (const message of normalized) {
          sendMessage(ws, message);
        }
      },

      onRequest: (msg) => {
        if (msg.method === 'session/request_permission') {
          connection.respond(msg.id, answerPermissionRequest(msg, devinMode, ws, sessionId || run.devinSessionId));
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
        const message = run.aborted
          ? 'Devin run aborted'
          : `Devin exited before finishing the turn${tail ? `: ${tail.trim().split('\n').pop()}` : ''}`;
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

      if (spawnError.error) {
        throw spawnError.error;
      }

      if (providerSessionId) {
        run.muted = true;
        try {
          await connection.call('session/load', {
            sessionId: providerSessionId,
            cwd: workingDirectory,
            mcpServers: [],
          }, HANDSHAKE_TIMEOUT_MS);
        } finally {
          run.muted = false;
        }
      } else {
        const created = await connection.call('session/new', {
          cwd: workingDirectory,
          mcpServers: [],
        }, HANDSHAKE_TIMEOUT_MS);

        const newId = created?.sessionId;
        if (newId) {
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
        try {
          await connection.call('session/set_config_option', {
            sessionId: run.devinSessionId,
            configId: 'model',
            value: resolvedModel,
          }, HANDSHAKE_TIMEOUT_MS);
        } catch (error) {
          console.warn('[Devin] session/set_config_option model failed:', error.message);
        }
      }

      // Attachments ride along as path references (the same <images_input> /
      // <files_input> contract Cursor and OpenCode use): the Devin agent reads
      // them with its own filesystem tools.
      const promptText = appendFilesInputTag(appendImagesInputTag(command, images), files);

      const result = await connection.call('session/prompt', {
        sessionId: run.devinSessionId,
        prompt: [{ type: 'text', text: promptText }],
      });

      if (run.aborted) {
        finish(0, true);
        resolve();
        return;
      }

      const stopReason = result?.stopReason;
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
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'devin',
        sessionId: sessionId || run.devinSessionId || null,
        error: detail,
        sessionName: sessionSummary,
      });
      hardFail(`Devin run failed: ${detail}`);
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
};
