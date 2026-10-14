/**
 * Отдельная «комната» (cgroup) для каждого агента — чтобы тяжёлая работа чата
 * не душила сам сайт.
 *
 * Как было. Агент (`claude`) и всё, что он запускает (сборки, ffmpeg, тесты),
 * жили в группе службы claudecodeui-shared вместе с веб-сервером. У группы
 * один потолок памяти (MemoryHigh). 22.09.26 чаты заняли 2,73 ГБ из 2,5 ГБ:
 * ядро тормозило всю группу, сервер 91–94% времени ждал память, а после
 * перезапуска больше 15 минут не мог даже открыть порт — Егор видел
 * «Секунду, обновляюсь».
 *
 * Как стало. Агент запускается через `systemd-run --user --scope` в срез
 * ccui-agents.slice пользовательского менеджера systemd (так же JupyterHub
 * запускает серверы пользователей — jupyterhub/systemdspawner). У среза свой
 * потолок и меньший вес процессора (~/.config/systemd/user/ccui-agents.slice,
 * копия — deploy/ccui-agents.slice), у каждого агента — свой потолок
 * MemoryHigh. Переполнился чат — тормозит он сам, сервер сайта остаётся в
 * своей группе один. Заодно агенты не входят в группу службы, поэтому
 * переживают её перезапуск и без KillMode=process.
 *
 * Обернуты ВСЕ места рождения агентов и тяжёлых детей сервера:
 * claude (survivor-runs), devin (супервизор и прямой запуск), codex-worker,
 * cursor-agent, opencode и встроенный терминал (pty). Новая точка спауна
 * обязана пройти через wrapInAgentRoom — иначе процесс родится в группе
 * сайта и будет есть его лимит.
 *
 * `--scope` сохраняет PID и каналы: systemd-run регистрирует группу и делает
 * exec в агента, поэтому SDK, «Стоп» и survivor-runs видят тот же процесс.
 *
 * Проба — сама себя не душит: пометка «комнаты недоступны» ставится только
 * после ДВУХ подряд провалов по 15 с (14.10.26 одиночный таймаут в 5 с под
 * нагрузкой выключал комнаты на минуту — агенты рождались в группе сайта).
 * Если менеджер пользователя совсем недоступен — запуск напрямую, как
 * раньше: чат важнее комнаты; сторож ~/self-heal таких стреев выносит из
 * группы сайта и докладывает. Выключить: CLOUDCLI_AGENT_ROOMS=off.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const SLICE = process.env.CLOUDCLI_AGENT_SLICE || 'ccui-agents.slice';
const AGENT_MEMORY_HIGH = process.env.CLOUDCLI_AGENT_MEMORY_HIGH || '2G';
const PROBE_OK_MS = 10 * 60 * 1000;
const PROBE_FAIL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const PROBE_FAILS_TO_DISABLE = 2;

let available = false;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeFailStreak = 0;

function managerEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const runtimeDir = baseEnv.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    return {
        ...baseEnv,
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: baseEnv.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
    };
}

function disabled(): boolean {
    return process.env.CLOUDCLI_AGENT_ROOMS === 'off';
}

/** Проба без блокировки сервера: создаётся пустая комната с `true`. */
function probe(): void {
    if (disabled()) {
        available = false;
        return;
    }
    let settled = false;
    const finish = (probeOk: boolean, reason: string) => {
        if (settled) return;
        settled = true;
        // Одиночный таймаут под нагрузкой — не отказ: комнаты отключаются
        // только после PROBE_FAILS_TO_DISABLE подряд, включаются сразу.
        probeFailStreak = probeOk ? 0 : probeFailStreak + 1;
        const next = probeOk || (probeFailStreak < PROBE_FAILS_TO_DISABLE && available);
        if (next !== available) {
            console.log(next
                ? `[agent-rooms] агенты запускаются в отдельных комнатах (${SLICE})`
                : `[agent-rooms] комнаты недоступны (${reason}, ${probeFailStreak} подряд) — агенты запускаются напрямую`);
        }
        if (!next && available) {
            alarm(`комнаты недоступны (${reason}) — агенты снова живут в группе сайта и могут его душить`);
        }
        available = next;
        schedule(available ? PROBE_OK_MS : PROBE_FAIL_MS);
    };
    try {
        const child = spawn('systemd-run', [
            '--user', '--scope', '--quiet', '--collect', `--slice=${SLICE}`, '--', 'true',
        ], { env: managerEnv(), stdio: 'ignore' });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(false, 'нет ответа за 15 с');
        }, PROBE_TIMEOUT_MS);
        timer.unref();
        child.once('error', (error) => { clearTimeout(timer); finish(false, error.message); });
        child.once('exit', (code) => { clearTimeout(timer); finish(code === 0, `код ${code}`); });
    } catch (error) {
        finish(false, (error as Error)?.message || String(error));
    }
}

function schedule(ms: number): void {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(probe, ms);
    probeTimer.unref();
}

// Тихий откат к прямому запуску воспроизводит исходную беду незаметно —
// поэтому о нём сообщаем в Telegram (не чаще раза в час).
const NOTIFY = '/home/claude/scripts/notify.sh';
let lastAlarm = 0;
function alarm(text: string): void {
    console.error(`[agent-rooms] ${text}`);
    if (Date.now() - lastAlarm < 60 * 60 * 1000 || !fs.existsSync(NOTIFY)) return;
    lastAlarm = Date.now();
    try {
        spawn(NOTIFY, [`Claude UI: ${text}`, 'error'], { stdio: 'ignore', detached: false }).on('error', () => {});
    } catch {
        // оповещение — не повод ронять запуск чата
    }
}

/** Через 3 с после запуска: агент действительно в своей комнате? */
export function verifyAgentRoom(pid: number | undefined, room: string | null): void {
    if (!pid || !room) return;
    setTimeout(() => {
        let cgroup = '';
        try {
            cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
        } catch {
            return; // процесс уже закончил
        }
        if (!cgroup.includes(room)) {
            alarm(`агент ${pid} не попал в свою комнату (${cgroup.trim()})`);
        }
    }, 3000).unref();
}

probe();

export type AgentRoomSpec = {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    room: string | null;
};

/**
 * Обернуть запуск агента в комнату. Возвращает то, что передать в spawn:
 * либо systemd-run с агентом внутри, либо исходную команду без изменений.
 * Вызывается из всех точек рождения процессов агентов: survivor-runs
 * (claude), devin-acp-client и devin-runtime (devin), codex-worker,
 * cursor-runtime, opencode-runtime, shell-websocket (терминал).
 */
export function wrapInAgentRoom(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv | undefined,
    appSessionId?: string | null,
): AgentRoomSpec {
    if (!available || disabled()) {
        return { command, args, env: env || process.env, room: null };
    }
    const tag = String(appSessionId || 'chat').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'chat';
    const unit = `ccui-agent-${tag}-${crypto.randomBytes(3).toString('hex')}`;
    return {
        command: 'systemd-run',
        args: [
            '--user', '--scope', '--quiet', '--collect',
            `--slice=${SLICE}`,
            `--unit=${unit}`,
            '-p', `MemoryHigh=${AGENT_MEMORY_HIGH}`,
            '--', command, ...args,
        ],
        env: managerEnv(env || process.env),
        room: `${unit}.scope`,
    };
}

export function agentRoomsAvailable(): boolean {
    return available;
}
