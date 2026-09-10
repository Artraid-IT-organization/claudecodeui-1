import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * Проверки сервиса снимков на настоящей файловой системе и настоящем git.
 *
 * Моки тут были бы бессмысленны: вся суть сервиса — во взаимодействии с git,
 * и подделка git проверяла бы только то, что мы правильно записали свои же
 * ожидания. Поэтому каждый тест поднимает временную папку-проект, снимает,
 * портит файлы и откатывает, глядя на реальное содержимое на диске.
 */

// Каталог снимков переопределяем ДО импорта сервиса: он читает переменную
// окружения на этапе загрузки модуля.
const CHECKPOINTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-checkpoints-'));
process.env.CLOUDCLI_CHECKPOINTS_DIR = CHECKPOINTS_DIR;

const { checkpointService } = await import('@/modules/checkpoints/checkpoint.service.js');

async function makeProject(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccui-project-'));
  await fsp.writeFile(path.join(dir, 'main.txt'), 'первая версия\n', 'utf8');
  await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'src', 'app.js'), 'console.log(1);\n', 'utf8');
  return dir;
}

test('снимок и откат возвращают прежнее содержимое файла', async () => {
  const project = await makeProject();

  const first = await checkpointService.snapshot({
    projectPath: project,
    sessionId: 'test-session',
    tool: 'Edit',
    file: path.join(project, 'main.txt'),
    force: true,
  });
  assert.ok(first, 'первый снимок должен создаться');

  // Агент «испортил» файл.
  await fsp.writeFile(path.join(project, 'main.txt'), 'испорченная версия\n', 'utf8');
  assert.equal(
    await fsp.readFile(path.join(project, 'main.txt'), 'utf8'),
    'испорченная версия\n',
  );

  const result = await checkpointService.restore(project, first as string, 'test-session');
  assert.ok(result.restored.includes('main.txt'), 'main.txt должен попасть в список возвращённых');
  assert.equal(
    await fsp.readFile(path.join(project, 'main.txt'), 'utf8'),
    'первая версия\n',
    'содержимое должно вернуться к снимку',
  );
});

test('перед откатом сохраняется страховочный снимок', async () => {
  const project = await makeProject();

  const base = await checkpointService.snapshot({
    projectPath: project,
    tool: 'Write',
    file: null,
    force: true,
  });
  assert.ok(base);

  await fsp.writeFile(path.join(project, 'main.txt'), 'состояние до отката\n', 'utf8');

  const result = await checkpointService.restore(project, base as string, null);
  assert.ok(result.safetyCheckpoint, 'страховочный снимок обязан появиться');

  // «Отменяем отмену»: возвращаемся к состоянию, которое было перед откатом.
  await checkpointService.restore(project, result.safetyCheckpoint as string, null);
  assert.equal(
    await fsp.readFile(path.join(project, 'main.txt'), 'utf8'),
    'состояние до отката\n',
    'страховочный снимок должен возвращать состояние, бывшее перед откатом',
  );
});

test('снимок не берёт зависимости, сборку и тяжёлые файлы', async () => {
  const project = await makeProject();

  // Мусор, которого в снимке быть не должно.
  await fsp.mkdir(path.join(project, 'node_modules', 'левый-пакет'), { recursive: true });
  await fsp.writeFile(path.join(project, 'node_modules', 'левый-пакет', 'index.js'), 'x'.repeat(5000));
  await fsp.mkdir(path.join(project, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(project, 'dist', 'bundle.js'), 'y'.repeat(5000));
  await fsp.writeFile(path.join(project, 'фото.png'), Buffer.alloc(4096));
  // Файл крупнее лимита в один мегабайт.
  await fsp.writeFile(path.join(project, 'огромный.txt'), 'z'.repeat(2 * 1024 * 1024));

  const id = await checkpointService.snapshot({
    projectPath: project,
    tool: 'Write',
    file: null,
    force: true,
  });
  assert.ok(id);

  // Портим отслеживаемый файл и откатываем: список возвращённых покажет,
  // что именно попало в снимок.
  await fsp.writeFile(path.join(project, 'main.txt'), 'другое\n', 'utf8');
  const result = await checkpointService.restore(project, id as string, null);

  assert.ok(result.restored.includes('main.txt'));
  const joined = result.restored.join('\n');
  assert.ok(!joined.includes('node_modules'), 'зависимости в снимок попадать не должны');
  assert.ok(!joined.includes('dist/'), 'сборка в снимок попадать не должна');
  assert.ok(!joined.includes('.png'), 'картинки в снимок попадать не должны');
  assert.ok(!joined.includes('огромный.txt'), 'файлы больше мегабайта в снимок попадать не должны');
});

test('без изменений новый снимок не создаётся', async () => {
  const project = await makeProject();

  const first = await checkpointService.snapshot({ projectPath: project, force: true });
  assert.ok(first, 'первый снимок создаётся');

  const second = await checkpointService.snapshot({ projectPath: project, force: true });
  assert.equal(second, null, 'если ничего не изменилось — снимать нечего');
});

test('частые вызовы подряд не плодят снимки', async () => {
  const project = await makeProject();

  await checkpointService.snapshot({ projectPath: project, force: true });

  await fsp.writeFile(path.join(project, 'main.txt'), 'правка раз\n', 'utf8');
  const a = await checkpointService.snapshot({ projectPath: project });

  await fsp.writeFile(path.join(project, 'main.txt'), 'правка два\n', 'utf8');
  const b = await checkpointService.snapshot({ projectPath: project });

  // Второй вызов приходит сразу за первым — он должен быть отсечён по времени.
  assert.ok(a === null || b === null, 'два снимка подряд в одну секунду недопустимы');
});

test('список снимков отдаёт подписи и привязку к разговору', async () => {
  const project = await makeProject();

  await checkpointService.snapshot({
    projectPath: project,
    sessionId: 'сессия-42',
    tool: 'Edit',
    file: path.join(project, 'src', 'app.js'),
    force: true,
  });

  const list = await checkpointService.list(project);
  assert.ok(list.length >= 1, 'снимок должен появиться в списке');
  assert.equal(list[0].tool, 'Edit');
  assert.equal(list[0].sessionId, 'сессия-42');
  assert.ok(list[0].label.includes('app.js'), 'в подписи должен быть файл');
});
