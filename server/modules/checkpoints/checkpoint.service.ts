/**
 * Чекпойнты — «кнопка отмены» для работы агента.
 *
 * Смысл. Пока отката нет, каждый запуск агента — ставка: он идёт и правит
 * десяток файлов, и если понял задачу не так, вернуть как было нечем. Из-за
 * этого человек вынужден проверять каждый шаг, и половина выигрыша от
 * автоматики теряется. Чекпойнт снимает этот страх: перед каждым действием
 * агента система тихо делает снимок файлов, а вернуться к любому снимку можно
 * одним нажатием.
 *
 * Как устроено. Рядом с проектом заводится ВТОРОЙ, теневой git-репозиторий.
 * Он лежит не в папке проекта, а в служебном каталоге, и о нём не знает ни
 * обычный git проекта, ни сам проект: у git есть режим «база здесь, а рабочая
 * папка там» (--git-dir + --work-tree), он ровно для таких случаев. Поэтому
 * снимки не засоряют историю проекта, не попадают в чужие коммиты и не могут
 * быть случайно отправлены на GitHub.
 *
 * Что НЕ попадает в снимок: результаты сборки, зависимости, виртуальные
 * окружения, медиафайлы и всё тяжелее мегабайта. Замер на живых проектах:
 * с этими фильтрами папка на 443 МБ даёт снимок в 14 МБ, а дальше git хранит
 * только разницу. Без фильтров первый же снимок съел бы гигабайты — на
 * сервере, где свободно четыре.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const CHECKPOINTS_ROOT =
  process.env.CLOUDCLI_CHECKPOINTS_DIR ||
  path.join(process.env.HOME || '/home/claude', '.cloudcli-shared', 'checkpoints');

/** Не чаще одного снимка в этот промежуток: агент бывает делает правки пачками. */
const MIN_INTERVAL_MS = 2500;

/** Сколько снимков держим на проект. Старые уходят, чтобы не пухнуть без предела. */
const MAX_CHECKPOINTS = 300;

/** Файлы тяжелее — не наши: это сборка, медиа или архивы. */
const MAX_FILE_SIZE_KB = 1024;

/*
 * Потолок на размер проекта.
 *
 * Замер на этой машине: домашний каталог целиком даёт 410 МБ и 19 тысяч
 * файлов даже после всех фильтров — это не проект, а всё хозяйство сразу.
 * Снимать такое бессмысленно (человек всё равно откатывает конкретную работу,
 * а не весь сервер), медленно (git перебирает девятнадцать тысяч путей на
 * каждое действие агента) и опасно: на диске свободно четыре гигабайта.
 *
 * Нормальный проект в эти рамки укладывается с запасом: claudecodeui — 1377
 * файлов и 10 МБ, sunschool — 144 файла и 14 МБ.
 */
const MAX_PROJECT_FILES = 6000;
const MAX_PROJECT_SIZE_MB = 120;

/**
 * Вердикт «снимаем этот проект или нет» — считается один раз и запоминается.
 * Пересчитывать на каждое действие агента накладно: это обход всего дерева.
 */
const projectEligibility = new Map<string, { ok: boolean; reason: string }>();

/**
 * Что игнорируем. Формат — как в .gitignore.
 *
 * Список намеренно широкий: лучше не снять лишний файл сборки, чем утащить в
 * снимок гигабайт зависимостей. Всё, что действительно правит агент — исходный
 * код, разметка, настройки, документация — сюда не попадает.
 */
const IGNORE_RULES = [
  'node_modules/',
  '.git/',
  'dist/',
  'dist-server/',
  'build/',
  '.next/',
  'out/',
  'coverage/',
  '.cache/',
  '.turbo/',
  'venv/',
  '.venv/',
  '__pycache__/',
  '*.pyc',
  '.pytest_cache/',
  'target/',
  'vendor/',
  '.gradle/',
  '*.log',
  '*.lock',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  '*.ico',
  '*.svg',
  '*.mp4',
  '*.mov',
  '*.wav',
  '*.mp3',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.pdf',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.docx',
  '*.xlsx',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.bin',
  '*.so',
  '*.dylib',
  '*.node',
  '.DS_Store',
];

export type Checkpoint = {
  /** Короткий идентификатор снимка (хеш коммита в теневом репозитории). */
  id: string;
  /** Что собирался сделать агент: «Edit · src/App.tsx». */
  label: string;
  /** Имя инструмента, перед которым сняли: Edit, Write, Bash… */
  tool: string | null;
  /** Файл, которого касалось действие, если он известен. */
  file: string | null;
  /** Разговор, в рамках которого сделан снимок. */
  sessionId: string | null;
  createdAt: string;
  /** Сколько файлов отличается от предыдущего снимка. */
  changedFiles: number;
};

type RunResult = { code: number; stdout: string; stderr: string };

/** Запускает git и ждёт результата. Без shell — аргументы не интерпретируются. */
function run(args: string[], cwd: string, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        // Снимки — служебные, автор фиксированный, чтобы не зависеть от
        // настроек git пользователя (которых может не быть вовсе).
        GIT_AUTHOR_NAME: 'Checkpoints',
        GIT_AUTHOR_EMAIL: 'checkpoints@cloudcli.local',
        GIT_COMMITTER_NAME: 'Checkpoints',
        GIT_COMMITTER_EMAIL: 'checkpoints@cloudcli.local',
        // Ничего не спрашиваем у человека: сервис работает в фоне.
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(error) });
    });
  });
}

/**
 * Прикидывает, стоит ли вообще снимать этот проект.
 *
 * Обходит дерево, считая только то, что реально попало бы в снимок. Обход
 * прекращается досрочно, как только стало ясно, что порог превышен — на
 * домашнем каталоге это экономит секунды.
 */
async function isProjectEligible(projectPath: string): Promise<{ ok: boolean; reason: string }> {
  const cached = projectEligibility.get(projectPath);
  if (cached) return cached;

  const skipDirs = new Set([
    'node_modules', '.git', 'dist', 'dist-server', 'build', '.next', 'out',
    'coverage', '.cache', '.turbo', 'venv', '.venv', '__pycache__',
    '.pytest_cache', 'target', 'vendor', '.gradle',
  ]);
  const skipExt = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.mp4', '.mov',
    '.wav', '.mp3', '.zip', '.tar', '.gz', '.pdf', '.woff', '.woff2', '.ttf',
    '.eot', '.docx', '.xlsx', '.sqlite', '.sqlite3', '.db', '.bin', '.so',
    '.dylib', '.node', '.log',
  ]);

  let files = 0;
  let bytes = 0;
  let exceeded = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (exceeded || depth > 12) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (exceeded) return;
      if (entry.name.startsWith('.') && entry.isDirectory() && entry.name !== '.claude') {
        // Скрытые каталоги обычно служебные; .claude пропускаем осознанно —
        // он и так в списке исключений ниже по размеру.
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (skipExt.has(path.extname(entry.name).toLowerCase())) continue;

      try {
        const stat = await fsp.stat(path.join(dir, entry.name));
        if (stat.size > MAX_FILE_SIZE_KB * 1024) continue;
        files += 1;
        bytes += stat.size;
        if (files > MAX_PROJECT_FILES || bytes > MAX_PROJECT_SIZE_MB * 1024 * 1024) {
          exceeded = true;
          return;
        }
      } catch {
        // файл исчез между обходом и замером
      }
    }
  };

  await walk(projectPath, 0);

  const verdict = exceeded
    ? {
        ok: false,
        reason:
          `в папке больше ${MAX_PROJECT_FILES} файлов или ${MAX_PROJECT_SIZE_MB} МБ — ` +
          'снимки для неё отключены, чтобы не забить диск и не тормозить каждое действие',
      }
    : { ok: true, reason: '' };

  projectEligibility.set(projectPath, verdict);
  if (!verdict.ok) {
    console.warn(`[Чекпойнты] ${projectPath}: ${verdict.reason}`);
  }
  return verdict;
}

/** Устойчивое имя папки под теневой репозиторий конкретного проекта. */
function shadowDirFor(projectPath: string): string {
  const normalized = path.resolve(projectPath);
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  const readable = path.basename(normalized).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return path.join(CHECKPOINTS_ROOT, `${readable}-${hash}`);
}

/** Последний снимок на проект — чтобы не частить. */
const lastSnapshotAt = new Map<string, number>();

/** Одна операция на проект за раз: два снимка разом ломают индекс git. */
const projectLocks = new Map<string, Promise<unknown>>();

function withProjectLock<T>(projectPath: string, task: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectPath) ?? Promise.resolve();
  const next = previous.then(task, task);
  // Держим в карте «хвост» очереди, но не даём ей копить ошибки.
  projectLocks.set(
    projectPath,
    next.catch(() => undefined),
  );
  return next;
}

async function ensureShadowRepo(projectPath: string): Promise<string | null> {
  const shadowDir = shadowDirFor(projectPath);
  const gitDir = path.join(shadowDir, 'repo.git');

  try {
    if (!fs.existsSync(gitDir)) {
      await fsp.mkdir(shadowDir, { recursive: true });
      const init = await run(['init', '--bare', '--initial-branch=main', gitDir], shadowDir);
      if (init.code !== 0) {
        console.error('[Чекпойнты] не удалось создать теневой репозиторий:', init.stderr);
        return null;
      }
      // Теневой репозиторий обслуживает чужую рабочую папку, поэтому явно
      // говорим git, что владелец каталога может отличаться.
      await run(['--git-dir', gitDir, 'config', 'core.bare', 'false'], shadowDir);
      await run(['--git-dir', gitDir, 'config', 'core.worktree', path.resolve(projectPath)], shadowDir);
      await run(['--git-dir', gitDir, 'config', 'gc.auto', '0'], shadowDir);
    }

    // Список исключений держим в самом теневом репозитории: в папке проекта
    // не появляется ни одного нового файла.
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    await fsp.mkdir(path.dirname(excludeFile), { recursive: true });
    await fsp.writeFile(
      excludeFile,
      ['# Управляется сервисом чекпойнтов, правки не сохранятся.', ...IGNORE_RULES, ''].join('\n'),
      'utf8',
    );

    return gitDir;
  } catch (error) {
    console.error('[Чекпойнты] ошибка подготовки теневого репозитория:', error);
    return null;
  }
}

function gitArgs(gitDir: string, projectPath: string, args: string[]): string[] {
  return ['--git-dir', gitDir, '--work-tree', path.resolve(projectPath), ...args];
}

export type SnapshotInput = {
  projectPath: string;
  sessionId?: string | null;
  tool?: string | null;
  file?: string | null;
  /** Пропустить ограничение по частоте: для снимка перед откатом. */
  force?: boolean;
};

export const checkpointService = {
  /**
   * Делает снимок рабочей папки перед действием агента.
   *
   * Возвращает id снимка либо null, если снимать было нечего (ничего не
   * изменилось) или слишком рано после предыдущего. Ошибки не выбрасываются:
   * упавший снимок не должен ронять работу агента — в худшем случае человек
   * лишится одной точки отката, а не текущей задачи.
   */
  async snapshot(input: SnapshotInput): Promise<string | null> {
    const projectPath = input.projectPath;
    if (!projectPath || !fs.existsSync(projectPath)) return null;

    const now = Date.now();
    if (!input.force) {
      const previous = lastSnapshotAt.get(projectPath) ?? 0;
      if (now - previous < MIN_INTERVAL_MS) return null;
    }
    lastSnapshotAt.set(projectPath, now);

    // Слишком большая папка — снимки для неё не ведём вовсе.
    const eligibility = await isProjectEligible(projectPath);
    if (!eligibility.ok) return null;

    return withProjectLock(projectPath, async () => {
      const gitDir = await ensureShadowRepo(projectPath);
      if (!gitDir) return null;

      // Кладём в индекс всё, что проходит фильтры. Большие файлы отсекаются
      // отдельной проверкой ниже: у git нет встроенного «игнорируй тяжёлое».
      const add = await run(
        gitArgs(gitDir, projectPath, ['add', '-A', '--', '.']),
        projectPath,
        120_000,
      );
      if (add.code !== 0 && !add.stderr.includes('nothing')) {
        console.warn('[Чекпойнты] git add вернул ошибку:', add.stderr.slice(0, 300));
      }

      // Выкидываем из индекса всё, что тяжелее лимита.
      const listed = await run(
        gitArgs(gitDir, projectPath, ['diff', '--cached', '--name-only']),
        projectPath,
      );
      const staged = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      const tooBig: string[] = [];
      for (const relative of staged) {
        try {
          const stat = await fsp.stat(path.join(projectPath, relative));
          if (stat.size > MAX_FILE_SIZE_KB * 1024) tooBig.push(relative);
        } catch {
          // Файл мог исчезнуть между вызовами — это нормально, пропускаем.
        }
      }
      if (tooBig.length > 0) {
        // Порциями: аргументов может быть много, командная строка не резиновая.
        for (let i = 0; i < tooBig.length; i += 100) {
          const chunk = tooBig.slice(i, i + 100);
          await run(gitArgs(gitDir, projectPath, ['reset', '-q', '--', ...chunk]), projectPath);
        }
      }

      const changed = await run(
        gitArgs(gitDir, projectPath, ['diff', '--cached', '--name-only']),
        projectPath,
      );
      const changedFiles = changed.stdout.split('\n').filter((line) => line.trim()).length;
      if (changedFiles === 0) return null; // нечего снимать

      const toolName = input.tool || 'правка';
      const fileLabel = input.file ? path.relative(projectPath, input.file) || input.file : '';
      const label = fileLabel ? `${toolName} · ${fileLabel}` : toolName;

      const message = [
        label,
        '',
        `session: ${input.sessionId ?? '-'}`,
        `tool: ${input.tool ?? '-'}`,
        `file: ${fileLabel || '-'}`,
      ].join('\n');

      const commit = await run(
        gitArgs(gitDir, projectPath, ['commit', '--quiet', '--no-verify', '-m', message]),
        projectPath,
        120_000,
      );
      if (commit.code !== 0) {
        console.warn('[Чекпойнты] не удалось записать снимок:', commit.stderr.slice(0, 300));
        return null;
      }

      const head = await run(gitArgs(gitDir, projectPath, ['rev-parse', 'HEAD']), projectPath);
      const id = head.stdout.trim();

      void checkpointService.prune(projectPath).catch(() => undefined);
      return id || null;
    });
  },

  /** Список снимков проекта, свежие сверху. */
  async list(projectPath: string, limit = 100): Promise<Checkpoint[]> {
    if (!projectPath || !fs.existsSync(projectPath)) return [];
    const gitDir = path.join(shadowDirFor(projectPath), 'repo.git');
    if (!fs.existsSync(gitDir)) return [];

    const separator = '';
    const format = ['%H', '%aI', '%s', '%b'].join(separator);
    const log = await run(
      gitArgs(gitDir, projectPath, [
        'log',
        `--max-count=${Math.max(1, Math.min(limit, MAX_CHECKPOINTS))}`,
        `--format=${format}%x1e`,
      ]),
      projectPath,
    );
    if (log.code !== 0) return [];

    const entries = log.stdout.split('').map((chunk) => chunk.trim()).filter(Boolean);
    return entries.map((entry) => {
      const [id, createdAt, subject, body = ''] = entry.split(separator);
      const readField = (name: string): string | null => {
        const match = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(body);
        const value = match?.[1]?.trim();
        return value && value !== '-' ? value : null;
      };
      return {
        id,
        label: subject || 'снимок',
        tool: readField('tool'),
        file: readField('file'),
        sessionId: readField('session'),
        createdAt,
        changedFiles: 0,
      };
    });
  },

  /** Что именно изменится при откате к снимку — список файлов. */
  async diffAgainst(projectPath: string, checkpointId: string): Promise<string[]> {
    const gitDir = path.join(shadowDirFor(projectPath), 'repo.git');
    if (!fs.existsSync(gitDir)) return [];
    const result = await run(
      gitArgs(gitDir, projectPath, ['diff', '--name-only', checkpointId, '--']),
      projectPath,
    );
    if (result.code !== 0) return [];
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  },

  /**
   * Возвращает файлы проекта к состоянию снимка.
   *
   * Перед откатом обязательно снимает текущее состояние — чтобы «отменить
   * отмену» было чем. Без этого откат был бы необратимой операцией, а таких
   * в интерфейсе быть не должно.
   */
  async restore(
    projectPath: string,
    checkpointId: string,
    sessionId?: string | null,
  ): Promise<{ restored: string[]; safetyCheckpoint: string | null }> {
    if (!projectPath || !fs.existsSync(projectPath)) {
      throw new Error('папка проекта не найдена');
    }
    if (!/^[0-9a-f]{7,40}$/i.test(checkpointId)) {
      throw new Error('некорректный номер снимка');
    }

    const safetyCheckpoint = await checkpointService.snapshot({
      projectPath,
      sessionId,
      tool: 'перед откатом',
      file: null,
      force: true,
    });

    return withProjectLock(projectPath, async () => {
      const gitDir = await ensureShadowRepo(projectPath);
      if (!gitDir) throw new Error('теневой репозиторий недоступен');

      const willChange = await run(
        gitArgs(gitDir, projectPath, ['diff', '--name-only', checkpointId, '--']),
        projectPath,
      );
      const restored = willChange.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

      // Возвращаем содержимое файлов из снимка в рабочую папку. Файлы, которых
      // в снимке не было, остаются на месте: удалять то, что человек мог
      // создать руками между снимками, сервис права не имеет.
      const checkout = await run(
        gitArgs(gitDir, projectPath, ['checkout', checkpointId, '--', '.']),
        projectPath,
        120_000,
      );
      if (checkout.code !== 0) {
        throw new Error(`не удалось вернуть файлы: ${checkout.stderr.slice(0, 200)}`);
      }

      // Индекс после checkout указывает на старое состояние — приводим его в
      // соответствие рабочей папке, иначе следующий снимок увидит мнимые правки.
      await run(gitArgs(gitDir, projectPath, ['add', '-A', '--', '.']), projectPath, 120_000);

      return { restored, safetyCheckpoint };
    });
  },

  /** Держит историю в разумных границах: старые снимки отпадают. */
  async prune(projectPath: string): Promise<void> {
    const gitDir = path.join(shadowDirFor(projectPath), 'repo.git');
    if (!fs.existsSync(gitDir)) return;

    const count = await run(gitArgs(gitDir, projectPath, ['rev-list', '--count', 'HEAD']), projectPath);
    const total = Number(count.stdout.trim());
    if (!Number.isFinite(total) || total <= MAX_CHECKPOINTS) return;

    // Обрезаем историю: оставляем последние MAX_CHECKPOINTS снимков, остальное
    // становится новым «корнем». Так место не растёт бесконечно.
    const keepFrom = await run(
      gitArgs(gitDir, projectPath, ['rev-parse', `HEAD~${MAX_CHECKPOINTS - 1}`]),
      projectPath,
    );
    const base = keepFrom.stdout.trim();
    if (!base) return;

    await run(gitArgs(gitDir, projectPath, ['replace', '--graft', base]), projectPath);
    await run(['--git-dir', gitDir, 'filter-branch', '-f', '--', '--all'], projectPath, 300_000);
    await run(['--git-dir', gitDir, 'replace', '-d', base], projectPath);
    await run(['--git-dir', gitDir, 'reflog', 'expire', '--expire=now', '--all'], projectPath);
    await run(['--git-dir', gitDir, 'gc', '--prune=now', '--quiet'], projectPath, 300_000);
  },

  /** Сколько места занимают снимки проекта — для показа человеку. */
  async diskUsage(projectPath: string): Promise<number> {
    const gitDir = path.join(shadowDirFor(projectPath), 'repo.git');
    if (!fs.existsSync(gitDir)) return 0;

    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          try {
            total += (await fsp.stat(full)).size;
          } catch {
            // файл исчез между обходом и замером
          }
        }
      }
    };
    try {
      await walk(gitDir);
    } catch {
      return 0;
    }
    return total;
  },
};
