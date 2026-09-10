import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * Проверки доски объявлений на настоящей базе.
 *
 * Ставка здесь не на «функция вернула объект», а на поведение двух чатов,
 * которые лезут в один файл: один должен пройти, второй — подождать и либо
 * пройти следом, либо получить внятный отказ.
 */

// База — временная, чтобы тест не трогал рабочую.
const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-coord-')), 'test.db');
process.env.DATABASE_PATH = TMP_DB;
process.env.CLOUDCLI_DB_PATH = TMP_DB;

const { getConnection } = await import('@/modules/database/index.js');
const { fileReservations } = await import('@/modules/coordination/index.js');

// Пользовательской таблицы тут не нужно — сервис создаёт свою сам.
getConnection();

const PROJECT = '/tmp/проект-для-проверки';
const FILE = `${PROJECT}/настройки.js`;

test('свободный файл берётся сразу', async () => {
  const result = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: FILE,
    sessionId: 'чат-А',
    sessionTitle: 'Оформление',
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.reservationId > 0);
    assert.ok(result.waitedMs < 500, 'ждать свободный файл не приходится');
    fileReservations.release(result.reservationId);
  }
});

test('занятый файл заставляет второй чат ждать, потом отказ с именем держателя', async () => {
  const first = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: FILE,
    sessionId: 'чат-А',
    sessionTitle: 'Оформление',
  });
  assert.equal(first.ok, true);

  const startedAt = Date.now();
  const second = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: FILE,
    sessionId: 'чат-Б',
    sessionTitle: 'Расчёты',
    maxWaitMs: 2000, // в тесте ждём коротко, в бою — тридцать секунд
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(second.ok, false, 'занятый файл второму чату не достаётся');
  if (!second.ok) {
    assert.equal(second.holder.sessionId, 'чат-А');
    assert.equal(second.holder.sessionTitle, 'Оформление', 'в отказе видно, кто держит файл');
  }
  assert.ok(elapsed >= 1800, 'второй чат действительно ждал, а не отказал сразу');

  if (first.ok) fileReservations.release(first.reservationId);
});

test('после освобождения второй чат проходит', async () => {
  const first = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: FILE,
    sessionId: 'чат-А',
  });
  assert.equal(first.ok, true);

  // Первый отпускает файл через полсекунды — как в жизни, правка быстрая.
  if (first.ok) {
    setTimeout(() => fileReservations.release(first.reservationId), 500);
  }

  const second = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: FILE,
    sessionId: 'чат-Б',
    maxWaitMs: 5000,
  });

  assert.equal(second.ok, true, 'дождавшись очереди, второй чат берёт файл');
  if (second.ok) {
    assert.ok(second.waitedMs >= 400, 'ожидание было настоящим');
    fileReservations.release(second.reservationId);
  }
});

test('разные файлы не мешают друг другу', async () => {
  const a = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: `${PROJECT}/стили.css`,
    sessionId: 'чат-А',
  });
  const b = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: `${PROJECT}/расчёты.js`,
    sessionId: 'чат-Б',
    maxWaitMs: 1000,
  });

  assert.equal(a.ok, true);
  assert.equal(b.ok, true, 'два чата в разных файлах работают одновременно');

  if (a.ok) fileReservations.release(a.reservationId);
  if (b.ok) fileReservations.release(b.reservationId);
});

test('тот же чат не блокирует сам себя', async () => {
  const first = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: FILE,
    sessionId: 'чат-А',
  });
  const again = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: FILE,
    sessionId: 'чат-А',
    maxWaitMs: 1000,
  });

  assert.equal(first.ok, true);
  assert.equal(again.ok, true, 'свой же файл берётся повторно без ожидания');

  if (first.ok) fileReservations.release(first.reservationId);
  if (again.ok) fileReservations.release(again.reservationId);
});

test('протухшая бронь освобождает файл сама', async () => {
  const short = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: `${PROJECT}/временный.txt`,
    sessionId: 'чат-упавший',
    ttlMs: 300, // как будто чат умер, не сняв бронь
  });
  assert.equal(short.ok, true);

  await new Promise((resolve) => setTimeout(resolve, 600));

  const next = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: `${PROJECT}/временный.txt`,
    sessionId: 'чат-живой',
    maxWaitMs: 1000,
  });
  assert.equal(next.ok, true, 'по истечении срока файл достаётся следующему');
  if (next.ok) fileReservations.release(next.reservationId);
});

test('завершение разговора отпускает все его файлы', async () => {
  await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: `${PROJECT}/один.js`,
    sessionId: 'чат-В',
  });
  await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: `${PROJECT}/два.js`,
    sessionId: 'чат-В',
  });

  assert.equal(
    fileReservations.active(PROJECT).filter((r) => r.sessionId === 'чат-В').length,
    2,
    'два файла заняты',
  );

  fileReservations.releaseSession('чат-В');

  assert.equal(
    fileReservations.active(PROJECT).filter((r) => r.sessionId === 'чат-В').length,
    0,
    'после завершения разговора файлы свободны',
  );
});

test('список занятого показывает, кто и что держит', async () => {
  const lease = await fileReservations.acquire({
    projectPath: PROJECT,
    filePath: `${PROJECT}/видимый.js`,
    sessionId: 'чат-Г',
    sessionTitle: 'Правки по дизайну',
  });
  assert.equal(lease.ok, true);

  const active = fileReservations.active(PROJECT);
  const found = active.find((item) => item.filePath.endsWith('видимый.js'));
  assert.ok(found, 'занятый файл виден в списке');
  assert.equal(found?.sessionTitle, 'Правки по дизайну');

  if (lease.ok) fileReservations.release(lease.reservationId);
});
