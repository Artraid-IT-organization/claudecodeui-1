/**
 * Чаты, переживающие перезапуск сайта.
 *
 * Как было. Агент (процесс `claude`) — дочерний процесс веб-сервера. При
 * остановке сервера SDK на выходе посылает всем своим дочерним процессам
 * SIGTERM, и работа обрывается посреди задачи. Проверено пробой 13.09.26:
 * при штатной остановке родителя агент погибал, не дописав отметку; при
 * мгновенном убийстве родителя (уборка SDK не срабатывает) агент спокойно
 * доводил задачу до конца и дописывал переписку в файл.
 *
 * Как стало. Сервер сам запускает процесс агента (опция SDK
 * `spawnClaudeCodeProcess`) и:
 *   1. на время остановки сервера делает «убить» пустой операцией — уборка
 *      SDK больше не достаёт агентов (systemd тоже их не трогает: у службы
 *      KillMode=process);
 *   2. кладёт на диск запись «процесс PID ведёт чат X» — чтобы новый сервер
 *      после старта нашёл продолжающие работу чаты;
 *   3. после старта «усыновляет» живые записи: чат показывается как
 *      работающий, изменения его переписки рассылаются открытым вкладкам, а
 *      когда процесс закончил — вкладки узнают, что чат свободен. «Стоп»
 *      останавливает такой процесс напрямую.
 *
 * Модуль — лист: ничего из приложения не импортирует, всё, что нужно
 * рассылать, передаётся колбэками из server/index.ts. Иначе получился бы
 * круг импортов с наблюдателем за переписками.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let shuttingDown = false;
/** appSessionId → { pid, providerSessionId, configDir, startedAt, transcriptPath, transcriptMtime } */
const survivors = new Map();
let pollTimer = null;

function liveRunsDir() {
  return process.env.CLOUDCLI_LIVE_RUNS_DIR || path.join(os.homedir(), '.cloudcli-shared', 'live-runs');
}

function recordPath(pid) {
  return path.join(liveRunsDir(), `${pid}.json`);
}

function writeRecord(pid, record) {
  try {
    fs.mkdirSync(liveRunsDir(), { recursive: true });
    fs.writeFileSync(recordPath(pid), JSON.stringify(record));
  } catch (error) {
    console.error('[survivor-runs] запись о запуске не сохранилась:', error?.message || error);
  }
}

function removeRecord(pid) {
  try {
    fs.unlinkSync(recordPath(pid));
  } catch {
    // уже нет — нечего убирать
  }
}

/** Жив ли процесс и это ли всё ещё агент Claude (PID мог достаться другой программе). */
function isAgentAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('claude') && cmdline.includes('stream-json');
  } catch {
    return false;
  }
}

/** Сервер останавливается: с этого момента «убить агента» — пустая операция. */
export function markShuttingDown() {
  shuttingDown = true;
}

/**
 * Замена стандартного запуска процесса в SDK. Повторяет его один в один
 * (те же каналы, окружение, сигнал отмены), но запоминает PID и не даёт
 * уборке SDK убить агента при остановке сервера.
 */
export function spawnSurvivableClaude(spawnOptions, context = {}) {
  const { command, args, cwd, env, signal } = spawnOptions;
  const child = spawn(command, args, {
    cwd,
    env,
    signal,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });

  if (child.pid && context.appSessionId) {
    writeRecord(child.pid, {
      pid: child.pid,
      appSessionId: context.appSessionId,
      providerSessionId: context.providerSessionId || null,
      configDir: context.configDir || null,
      startedAt: Date.now(),
    });
    child.once('exit', () => {
      // Выход во время остановки сервера — не наш случай: сервер умирает, а
      // агент нет. Запись нужна новому серверу.
      if (!shuttingDown) {
        removeRecord(child.pid);
      }
    });
    retireStaleRuns(context.providerSessionId, child.pid);
  }

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill(sig) {
      if (shuttingDown) {
        return false;
      }
      return child.kill(sig);
    },
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  };
}

/**
 * Один разговор — один агент. Новый ход продолжает разговор новым процессом, а
 * прежний обычно уходит сам: его прерывают и закрывают ему вход. Если прежний
 * этого не услышал (вход ему уже закрыли, а он доделывал очередь), он работает
 * дальше невидимкой — 15.09.26 две копии агента полчаса переписывали одни и те
 * же файлы. Поэтому через паузу прежний процесс того же разговора гасим сигналом.
 */
function retireStaleRuns(providerSessionId, freshPid) {
  if (!providerSessionId) return;
  let files = [];
  try {
    files = fs.readdirSync(liveRunsDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  const stalePids = [];
  for (const name of files) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(liveRunsDir(), name), 'utf8'));
      if (record.providerSessionId === providerSessionId && record.pid !== freshPid && isAgentAlive(record.pid)) {
        stalePids.push(record.pid);
      }
    } catch {
      // битая запись — пропускаем
    }
  }
  if (stalePids.length === 0) return;
  const graceMs = Number(process.env.CLOUDCLI_STALE_RUN_GRACE_MS || 5000);
  const timer = setTimeout(() => {
    for (const pid of stalePids) {
      if (!isAgentAlive(pid)) continue;
      console.warn(`[survivor-runs] разговор ${providerSessionId} продолжил новый процесс ${freshPid}, прежний ${pid} не остановился сам — останавливаю`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // уже завершился
      }
      removeRecord(pid);
      for (const [appSessionId, survivor] of survivors) {
        if (survivor.pid === pid) survivors.delete(appSessionId);
      }
    }
  }, graceMs);
  timer.unref?.();
}

/** Агент сообщил свой номер разговора — дописать в запись, чтобы найти файл переписки. */
export function noteSurvivorProviderSession(appSessionId, providerSessionId) {
  if (!appSessionId || !providerSessionId) return;
  let files = [];
  try {
    files = fs.readdirSync(liveRunsDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of files) {
    const file = path.join(liveRunsDir(), name);
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.appSessionId === appSessionId && record.providerSessionId !== providerSessionId) {
        record.providerSessionId = providerSessionId;
        fs.writeFileSync(file, JSON.stringify(record));
      }
    } catch {
      // битая запись — пропускаем
    }
  }
}

function findTranscript(record) {
  if (!record.providerSessionId || !record.configDir) return null;
  const root = path.join(record.configDir, 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${record.providerSessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * После старта сервера: найти агентов, переживших прошлый сервер, и следить
 * за ними. `onTranscriptChange(appSessionId)` — переписка изменилась,
 * `onGone(appSessionId)` — агент закончил.
 *
 * @param {{ onTranscriptChange?: (appSessionId: string) => void, onGone?: (appSessionId: string) => void, pollMs?: number }} [options]
 */
export function adoptSurvivors({ onTranscriptChange = (_id) => {}, onGone = (_id) => {}, pollMs = 3000 } = {}) {
  shuttingDown = false;
  let files = [];
  try {
    files = fs.readdirSync(liveRunsDir()).filter((name) => name.endsWith('.json'));
  } catch {
    files = [];
  }

  for (const name of files) {
    const file = path.join(liveRunsDir(), name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!record?.pid || !record.appSessionId || !isAgentAlive(record.pid)) {
      removeRecord(record?.pid ?? name.replace(/\.json$/, ''));
      continue;
    }
    const transcriptPath = findTranscript(record);
    survivors.set(record.appSessionId, {
      ...record,
      transcriptPath,
      transcriptMtime: transcriptPath ? mtimeOf(transcriptPath) : 0,
    });
    console.log(`[survivor-runs] чат ${record.appSessionId} пережил перезапуск (PID ${record.pid}), продолжаю показывать его работу`);
  }

  if (pollTimer) clearInterval(pollTimer);
  if (pollMs > 0) {
    pollTimer = setInterval(() => pollSurvivors({ onTranscriptChange, onGone }), pollMs);
    pollTimer.unref?.();
  }
  return listSurvivors();
}

/**
 * @param {{ onTranscriptChange?: (appSessionId: string) => void, onGone?: (appSessionId: string) => void }} [options]
 */
export function pollSurvivors({ onTranscriptChange = (_id) => {}, onGone = (_id) => {} } = {}) {
  for (const [appSessionId, survivor] of survivors) {
    if (!isAgentAlive(survivor.pid)) {
      survivors.delete(appSessionId);
      removeRecord(survivor.pid);
      onGone(appSessionId);
      continue;
    }
    if (!survivor.transcriptPath) {
      survivor.transcriptPath = findTranscript(survivor);
    }
    const mtime = survivor.transcriptPath ? mtimeOf(survivor.transcriptPath) : 0;
    if (mtime && mtime !== survivor.transcriptMtime) {
      survivor.transcriptMtime = mtime;
      onTranscriptChange(appSessionId);
    }
  }
}

export function isSurvivorRunning(appSessionId) {
  return Boolean(appSessionId) && survivors.has(appSessionId);
}

export function listSurvivors() {
  return Array.from(survivors.values()).map((survivor) => ({
    sessionId: survivor.appSessionId,
    provider: 'claude',
    startedAt: survivor.startedAt,
    lastSeq: 0,
  }));
}

/** «Стоп» для пережившего перезапуск агента: сервер уже не держит его канал, остаётся сигнал. */
export function stopSurvivor(appSessionId) {
  const survivor = survivors.get(appSessionId);
  if (!survivor) return false;
  try {
    process.kill(survivor.pid, 'SIGTERM');
  } catch {
    // уже завершился
  }
  survivors.delete(appSessionId);
  removeRecord(survivor.pid);
  return true;
}

/** Только для тестов. */
export function resetSurvivorsForTests() {
  survivors.clear();
  shuttingDown = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
