/**
 * «Обновления между серверами» — бэкенд плашки «Обновить» в панели слева.
 *
 * Зачем. Одно и то же приложение живёт на нескольких серверах (у Егора и у
 * сотрудников на втором), и каждая сторона иногда правит код у себя. Пул
 * изменений ездит через GitHub: сторож (deploy/selfhost/check-updates.sh,
 * крон ~30 мин) замечает свежий пул и пишет pending.json, а этот модуль
 * показывает его человеку и обрабатывает решение: применить, отложить или
 * разобрать в чате.
 *
 * Модуль сам ничего не скачивает и не собирает: обнаружение — дело сторожа
 * (ему нужны git-доступы и минуты на работу, а не десятки миллисекунд
 * HTTP-запроса). Применение — внешняя команда установки (CCUI_UPDATE_APPLY_CMD
 * или "applyCmd" в config.json): у каждой копии своя процедура выкатки с
 * проверками и откатом.
 *
 * Каталог состояния (CCUI_UPDATE_STATE_DIR, по умолчанию ~/.cloudcli/update-state):
 *   pending.json   — пул, который ждёт решения (коммиты, конфликт, откуда)
 *   dismissed.json — id пулов, скрытых «Отложить»; новый пул показывается снова
 *   apply.json     — последняя попытка применения (running/ok/failed)
 *
 * «Разобрать в чате» не рисует свой интерфейс разрешения конфликтов: создаётся
 * обычный чат, первым сообщением уходит подробный бриф с фактами и планом, и
 * разбирает его нейросеть ЭТОГО сервера — у неё есть git и контекст. Сообщение
 * уходит серверной очередью (queueChatMessage + dispatchChatQueues), поэтому
 * ответ начинается сразу, даже если вкладка уже закрыта.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsService } from '@/modules/providers/index.js';
import { dispatchChatQueues, queueChatMessage } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

/** Сколько ждать результат применения, прежде чем считать попытку зависшей. */
const APPLY_TIMEOUT_MS = 45 * 60 * 1000;
/** Коммитов в подписи плашки и подсказке — больше уже «простыня». */
const COMMIT_PREVIEW_LIMIT = 20;
/** Провайдер чата-разбора: на каждой копии работает та же модель, что и в чатах. */
const DISCUSS_PROVIDER = 'claude';
const DISCUSS_SESSION_NAME = 'Разбор обновления интерфейса';

type PendingCommit = { sha: string; subject: string; date: string; author: string };
type UpdateConflict = { kind: string; total?: number; items: Array<{ path: string; note: string }> };
type PendingUpdate = {
  id: string;
  label: string;
  remote: string;
  base: string;
  commits: PendingCommit[];
  filesChanged: number;
  diffStat: string;
  conflict: UpdateConflict | null;
  checkedAt: string;
};
type ApplyState = {
  id: string;
  state: 'running' | 'ok' | 'failed';
  startedTs?: number;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
};

export type UpdateStatus = {
  /** Пул, ждущий решения человека. Скрытые «Отложить» сюда не попадают. */
  pending: PendingUpdate | null;
  /** Скрытый пул — показываем мелкой строкой «есть отложенное», не плашкой. */
  dismissed: { id: string; commits: number } | null;
  applying: ApplyState | null;
  lastResult: ApplyState | null;
  /** Фича не подключена на этом экземпляре — фронт ничего не рисует. */
  configured: boolean;
};

/**
 * Настройки экземпляра. Службе может быть неудобно или невозможно менять
 * окружение (системный юнит, чужой сервер), поэтому конфиг живёт файлом
 * `config.json` в каталоге состояния — он пишется правами самого сервиса:
 *   {"applyCmd": "bash ~/cc2/cc2-update.sh --now", "repo": "/home/user/cc2/repo"}
 * Переменные окружения, если заданы, имеют приоритет — для юнитов, где
 * EnvironmentFile уже есть (cc2/app.env).
 */
type UpdatesConfig = { applyCmd?: string; repo?: string };

function stateDir(): string {
  return process.env.CCUI_UPDATE_STATE_DIR || path.join(os.homedir(), '.cloudcli', 'update-state');
}

function readConfig(): UpdatesConfig {
  return readJson<UpdatesConfig>(path.join(stateDir(), 'config.json')) ?? {};
}

function applyCmd(): string {
  return process.env.CCUI_UPDATE_APPLY_CMD || readConfig().applyCmd || '';
}

/** Каталог, в котором откроется чат-разбор (репозиторий обновления). */
function discussCwd(): string {
  return process.env.CCUI_UPDATE_REPO || readConfig().repo || process.env.HOME || os.homedir();
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readPending(): PendingUpdate | null {
  return readJson<PendingUpdate>(path.join(stateDir(), 'pending.json'));
}

function readApply(): ApplyState | null {
  return readJson<ApplyState>(path.join(stateDir(), 'apply.json'));
}

function readDismissedIds(): Set<string> {
  const list = readJson<string[]>(path.join(stateDir(), 'dismissed.json'));
  return new Set(Array.isArray(list) ? list : []);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1));
}

/**
 * Что сейчас показывать человеку. Модуль не настроен (нет apply-команды) —
 * `configured: false`, и интерфейс вообще не показывает плашку: на копиях без
 * обновлений лишний элемент в сайдбаре был бы только шумом.
 */
export function getUpdateStatus(): UpdateStatus {
  const configured = Boolean(applyCmd());
  const pending = readPending();
  const apply = readApply();
  const dismissed = readDismissedIds();

  const applying = apply?.state === 'running' ? apply : null;
  const lastResult = apply && apply.state !== 'running' ? apply : null;

  if (!pending || dismissed.has(pending.id)) {
    return {
      pending: null,
      dismissed: pending ? { id: pending.id, commits: pending.commits.length } : null,
      applying,
      lastResult,
      configured,
    };
  }
  return { pending, dismissed: null, applying, lastResult, configured };
}

/**
 * «Применить» — запуск установки внешней командой, отвечаем сразу.
 * Проверка `id` — обязательная: кнопка привязана к конкретному пулу, и если за
 * время показа пришёл новый, тихо ставить не то нельзя. Конфликтный пул без
 * force не ставится — это решение человек должен принять глазами (см. плашку).
 */
export function startApply(updateId: string, force: boolean): { started: true } {
  const cmd = applyCmd();
  if (!cmd) {
    throw new AppError('Обновление на этом экземпляре не настроено.', { statusCode: 409 });
  }
  const pending = readPending();
  if (!pending || pending.id !== updateId) {
    throw new AppError('Этого обновления уже нет — возможно, пришло новое. Обновите страницу.', { statusCode: 409 });
  }
  if (pending.conflict && !force) {
    throw new AppError('Обновление пересекается с локальными правками — сначала разберите конфликт.', { statusCode: 409 });
  }
  const apply = readApply();
  if (apply?.state === 'running') {
    throw new AppError('Обновление уже устанавливается.', { statusCode: 409 });
  }

  const now = Date.now();
  const applyFile = path.join(stateDir(), 'apply.json');
  writeJson(applyFile, {
    id: pending.id,
    state: 'running',
    startedTs: now,
    startedAt: new Date(now).toISOString(),
  });

  const logFile = path.join(stateDir(), 'apply.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn('bash', ['-c', cmd], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, CCUI_UPDATE_ID: pending.id },
  });
  child.unref();
  fs.closeSync(out);

  return { started: true };
}

/**
 * «Отложить» — скрыть плашку до следующего пула. Пул остаётся в pending.json
 * и в памяти: попросить применить его можно потом в любом чате («прими
 * обновление») — агент видит тот же файл состояния.
 */
export function dismissUpdate(updateId: string): { dismissed: true } {
  const ids = readDismissedIds();
  ids.add(updateId);
  writeJson(path.join(stateDir(), 'dismissed.json'), [...ids]);
  return { dismissed: true };
}

/**
 * Вернуть отложенный пул обратно в плашку — ссылка «есть отложенное» внизу
 * панели. Пул сам из pending.json никуда не девался, убираем только скрытие.
 */
export function restoreDismissedUpdate(updateId: string): { restored: true } {
  const ids = readDismissedIds();
  ids.delete(updateId);
  writeJson(path.join(stateDir(), 'dismissed.json'), [...ids]);
  return { restored: true };
}

/**
 * Бриф для чата-разбора. Пишется один раз здесь, а не в каждом инстансе:
 * факты подставляются из pending.json, который написал сторож.
 *
 * Составлен по схеме промптов Егора: кто пишет и зачем → факты с местами,
 * где их проверить → план работ → правила (когда спрашивать, когда нет).
 */
function buildDiscussPrompt(pending: PendingUpdate): string {
  const commitLines = pending.commits
    .slice(0, COMMIT_PREVIEW_LIMIT)
    .map((commit) => `  ${commit.sha} ${commit.subject}`)
    .join('\n');
  const moreCommits = pending.commits.length > COMMIT_PREVIEW_LIMIT
    ? `\n  … и ещё ${pending.commits.length - COMMIT_PREVIEW_LIMIT} (полный список: git -C <репозиторий> log ${pending.base.slice(0, 12)}..${pending.remote})`
    : '';
  const conflictLines = pending.conflict
    ? pending.conflict.items.map((item) => `  ${item.path} — ${item.note}`).join('\n')
    : '';

  const conflictPart = pending.conflict
    ? `КОНФЛИКТ: обновление пересекается с локальными правками этого сервера. Предварительная проверка (сухое наложение) нашла пересечения:
${conflictLines}

Порядок работы:
1. Изучи пересечение делом (git log/diff по затронутым файлам, сами локальные правки).
2. Проверь, не ложная ли это тревога: если наша правка уже влита в обновление целиком — конфликта нет, скажи об этом и предложи просто применить обновление.
3. Если конфликт настоящий — объясни человеку простым языком, без жаргона: что именно сталкивается, что потеряется при каждом исходе. Предложи варианты (по умолчанию — сохранить обе стороны: обновление + нашу правку, перенесённую на новую версию) и СПРОСИ, как поступить. Один вопрос, ответ одним словом.
4. После ответа примени решение сам (перенеси правку / разреши merge / прими сторону), затем запусти применение и проверь делом, что версия поднялась.
5. Если ответ «оставить как есть» — обновление остаётся отложенным, ничего не ломай.`
    : `Конфликтов с локальными правками не найдено — обновление можно ставить без риска.

Порядок работы:
1. Расскажи человеку простым языком, что в этом обновлении: главные изменения по списку коммитов выше, без жаргона, в 3–6 строках.
2. Спроси, применить ли его сейчас одним нажатием — или человек хочет что-то уточнить/пропустить.
3. При «применяй» — примени сам и проверь, что версия поднялась.`;

  return `[Чат открыт системой обновлений — это сообщение написано не человеком, а бэкендом по нажатию «Обсудить с чатом»]

На этом сервере ждёт решения обновление приложения «${pending.label}».

ФАКТЫ (проверяй командами, не словам):
- Репозиторий с кодом: ${discussCwd()}
- Сейчас работает: ${pending.base.slice(0, 12)}
- Пришло: ${pending.remote} → ${pending.id.slice(0, 12)} (${pending.commits.length} коммитов, ${pending.filesChanged} файлов${pending.diffStat ? `, ${pending.diffStat}` : ''})
- Файл состояния: ${path.join(stateDir(), 'pending.json')}
- Применить можно: POST /api/updates/apply с телом {"id": "${pending.id.slice(0, 12)}"} (или командой установки этого сервера)

Коммиты в пуле:
${commitLines}${moreCommits}

${conflictPart}

Общие правила: по-русски, коротко; не спрашивай о том, что можно проверить командой; решения с необратимыми последствиями — только после ответа человека.`;
}

/**
 * «Обсудить с чатом»: новый чат, первым сообщением — бриф с фактами пула.
 * Отправка серверной очередью: ход начинается сразу, вкладка не нужна.
 */
export function openDiscussChat(userId: string | null): { sessionId: string } {
  const pending = readPending();
  if (!pending) {
    throw new AppError('Сейчас нет ожидающего обновления — обсуждать нечего.', { statusCode: 409 });
  }

  const { sessionId } = sessionsService.createAppSession(DISCUSS_PROVIDER, discussCwd(), DISCUSS_SESSION_NAME);
  queueChatMessage({
    id: `upd_${Date.now().toString(36)}`,
    sessionId,
    userId,
    content: buildDiscussPrompt(pending),
    options: {},
  });
  dispatchChatQueues();
  return { sessionId };
}
