import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** Память проекта: проверки на настоящей базе, без подделок. */

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-memory-')), 'test.db');
process.env.DATABASE_PATH = TMP_DB;
process.env.CLOUDCLI_DB_PATH = TMP_DB;

const { getConnection } = await import('@/modules/database/index.js');
const { projectMemory, MAX_FACT_LENGTH } = await import('@/modules/memory/index.js');

getConnection();

const PROJECT = '/tmp/проект-памяти';

test('факт запоминается и читается', () => {
  const fact = projectMemory.remember({
    projectPath: PROJECT,
    text: 'Сборка запускается через npm run build:server',
    source: 'human',
  });

  assert.ok(fact);
  assert.equal(fact?.text, 'Сборка запускается через npm run build:server');
  assert.equal(fact?.source, 'human');

  const list = projectMemory.list(PROJECT);
  assert.ok(list.some((item) => item.text.includes('npm run build:server')));
});

test('повтор того же факта не создаёт дубликат', () => {
  const text = 'Порт 8765 занят другим ботом';
  projectMemory.remember({ projectPath: PROJECT, text });
  projectMemory.remember({ projectPath: PROJECT, text });
  projectMemory.remember({ projectPath: PROJECT, text });

  const matches = projectMemory.list(PROJECT).filter((item) => item.text === text);
  assert.equal(matches.length, 1, 'один и тот же вывод хранится один раз');
});

test('слишком длинный факт отклоняется', () => {
  assert.throws(
    () =>
      projectMemory.remember({
        projectPath: PROJECT,
        text: 'а'.repeat(MAX_FACT_LENGTH + 1),
      }),
    /длиннее/,
    'пересказ вместо вывода в память не пускаем',
  );
});

test('блок для промпта собирается из фактов', () => {
  const project = '/tmp/проект-для-блока';
  projectMemory.remember({ projectPath: project, text: 'Тесты гоняются через tsx --test' });
  projectMemory.remember({ projectPath: project, text: 'Папку dist руками не трогать' });

  const block = projectMemory.buildContextBlock(project);
  assert.ok(block.includes('tsx --test'));
  assert.ok(block.includes('dist'));
  assert.ok(block.includes('верь коду'), 'в блоке есть оговорка про устаревание');
});

test('без фактов блок пустой — промпт не меняется', () => {
  const block = projectMemory.buildContextBlock('/tmp/совсем-новый-проект');
  assert.equal(block, '', 'пустая память ничего не добавляет к промпту');
});

test('факт удаляется', () => {
  const project = '/tmp/проект-удаления';
  const fact = projectMemory.remember({ projectPath: project, text: 'Временная заметка' });
  assert.ok(fact);

  const removed = projectMemory.forget(project, fact!.id);
  assert.equal(removed, true);
  assert.equal(projectMemory.list(project).length, 0);
});

test('память не разрастается сверх предела', () => {
  const project = '/tmp/проект-предела';
  // Пишем заведомо больше лимита.
  for (let i = 0; i < 220; i++) {
    projectMemory.remember({ projectPath: project, text: `Факт номер ${i}` });
  }
  const count = projectMemory.list(project).length;
  assert.ok(count <= 200, `фактов должно остаться не больше 200, осталось ${count}`);
});

test('использованные факты вытесняются позже неиспользованных', () => {
  const project = '/tmp/проект-вытеснения';
  projectMemory.remember({ projectPath: project, text: 'Нужный факт' });
  // Отмечаем его использованным — он должен пережить наплыв новых.
  projectMemory.buildContextBlock(project);

  for (let i = 0; i < 210; i++) {
    projectMemory.remember({ projectPath: project, text: `Проходной факт ${i}` });
  }

  const survived = projectMemory.list(project).some((item) => item.text === 'Нужный факт');
  assert.equal(survived, true, 'факт, которым пользовались, вытесняется последним');
});
