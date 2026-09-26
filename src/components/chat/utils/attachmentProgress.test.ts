import assert from 'node:assert/strict';
import test from 'node:test';

import { computeAttachmentProgress, startAttachmentProgress } from './attachmentProgress';

const shot = { name: 'shot.png', size: 800 };
const doc = { name: 'doc.pdf', size: 200 };

test('на старте все вложения — 0%, чтобы затемнение появилось сразу', () => {
  assert.deepEqual([...startAttachmentProgress([shot, doc])], [['shot.png', 0], ['doc.pdf', 0]]);
  assert.equal(startAttachmentProgress([]).size, 0);
});

test('файлы доходят по очереди: первый заполняется раньше второго', () => {
  // 1000 байт файлов + 100 байт заголовков multipart → по 50 на файл.
  const half = computeAttachmentProgress([shot, doc], 425, 1100);
  assert.equal(half.get('shot.png'), 50);
  assert.equal(half.get('doc.pdf'), 0);

  const firstDone = computeAttachmentProgress([shot, doc], 975, 1100);
  assert.equal(firstDone.get('shot.png'), 99);
  assert.equal(firstDone.get('doc.pdf'), 50);
});

test('100% не показывается до ответа сервера: максимум 99', () => {
  const sent = computeAttachmentProgress([shot, doc], 1100, 1100);
  assert.deepEqual([...sent.values()], [99, 99]);
  // Браузер иногда отдаёт loaded > total — не выходим за предел.
  assert.deepEqual([...computeAttachmentProgress([shot], 5000, 900).values()], [99]);
});

test('проценты не убывают по ходу отправки', () => {
  let previous = [0, 0];
  for (let loaded = 0; loaded <= 1100; loaded += 37) {
    const now = [...computeAttachmentProgress([shot, doc], loaded, 1100).values()];
    now.forEach((value, index) => assert.ok(value >= previous[index], `${loaded}: ${now} < ${previous}`));
    previous = now;
  }
});

test('одинаковые имена: строка показывает отстающий файл', () => {
  const twins = [{ name: 'image.png', size: 500 }, { name: 'image.png', size: 500 }];
  assert.equal(computeAttachmentProgress(twins, 500, 1000).get('image.png'), 0);
});

test('пустой файл и нулевой total не дают NaN', () => {
  const progress = computeAttachmentProgress([{ name: 'empty.txt', size: 0 }], 0, 0);
  assert.equal(progress.get('empty.txt'), 0);
});
