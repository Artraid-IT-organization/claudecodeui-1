import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { forgetTranscriptTail, readSessionLines } from '../transcript-tail-cache.js';

const SESSION = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

function row(session: string, index: number): string {
  return JSON.stringify({ sessionId: session, n: index, text: `строка ${index}` });
}

/**
 * Временные каталоги этого файла — чтобы убрать их после прогона.
 *
 * Раньше каждый тест создавал каталог и не убирал его. Тесты с большими
 * стенограммами оставляли по 120 МБ за прогон, и к 09.09 в /tmp скопился
 * почти гигабайт при свободных двух с половиной — то есть проверка защиты
 * от переполнения памяти сама подъедала диск.
 */
const temporaryDirectories: string[] = [];

async function makeFile(rows: string[]): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tail-cache-'));
  temporaryDirectories.push(dir);
  const file = path.join(dir, 'transcript.jsonl');
  await fsp.writeFile(file, rows.join('\n') + '\n', 'utf8');
  return file;
}

test.after(async () => {
  forgetTranscriptTail();
  await Promise.all(
    temporaryDirectories.map((dir) => fsp.rm(dir, { recursive: true, force: true })),
  );
  temporaryDirectories.length = 0;
});

test('читает строки только своего сеанса', async () => {
  forgetTranscriptTail();
  const file = await makeFile([row(SESSION, 1), row(OTHER, 2), row(SESSION, 3)]);
  const result = await readSessionLines(file, SESSION, null);
  assert.equal(result.total, 2);
  assert.equal(result.complete, true);
  assert.deepEqual(result.lines.map((l) => JSON.parse(l).n), [1, 3]);
});

test('дочитывает только дописанное, не теряя и не удваивая строки', async () => {
  forgetTranscriptTail();
  const file = await makeFile([row(SESSION, 1), row(SESSION, 2)]);
  const first = await readSessionLines(file, SESSION, null);
  assert.equal(first.total, 2);

  await fsp.appendFile(file, row(SESSION, 3) + '\n', 'utf8');
  const second = await readSessionLines(file, SESSION, null);
  assert.equal(second.total, 3);
  assert.deepEqual(second.lines.map((l) => JSON.parse(l).n), [1, 2, 3]);
});

test('незавершённая последняя строка не засчитывается, пока её не дописали', async () => {
  forgetTranscriptTail();
  const file = await makeFile([row(SESSION, 1)]);
  // Обрывок без перевода строки — так выглядит файл, в который пишут прямо сейчас.
  const partial = row(SESSION, 2);
  await fsp.appendFile(file, partial.slice(0, 20), 'utf8');

  const during = await readSessionLines(file, SESSION, null);
  assert.equal(during.total, 1, 'обрывок не должен попадать в результат');

  await fsp.appendFile(file, partial.slice(20) + '\n', 'utf8');
  const after = await readSessionLines(file, SESSION, null);
  assert.equal(after.total, 2, 'дописанная строка должна появиться целиком');
  assert.deepEqual(after.lines.map((l) => JSON.parse(l).n), [1, 2]);
});

test('переписанный файл читается заново, а не дочитывается', async () => {
  forgetTranscriptTail();
  const file = await makeFile([row(SESSION, 1), row(SESSION, 2), row(SESSION, 3)]);
  await readSessionLines(file, SESSION, null);

  await fsp.writeFile(file, row(SESSION, 9) + '\n', 'utf8');
  const again = await readSessionLines(file, SESSION, null);
  assert.equal(again.total, 1);
  assert.deepEqual(again.lines.map((l) => JSON.parse(l).n), [9]);
});

test('запрос «всю историю» у огромного файла отдаёт хвост и честно признаётся, что он не весь', async () => {
  forgetTranscriptTail();
  // Стенограмма нарочно больше потолка полного чтения (12 МБ): такие у Егора
  // уже есть, и раньше именно на них служба падала по памяти.
  const big = 'я'.repeat(1024 * 1024);
  const rows = Array.from({ length: 60 }, (_, i) =>
    JSON.stringify({ sessionId: SESSION, n: i, text: big }));
  const file = await makeFile(rows);

  const first = await readSessionLines(file, SESSION, null);
  assert.ok(first.lines.length > 0, 'хвост переписки должен прийти');
  assert.ok(first.lines.length < 60, 'весь файл целиком в память не читаем');
  assert.equal(first.complete, false, 'ответ неполный — кнопка «показать ранние» нужна');
  // Пришёл именно конец переписки, а не её начало.
  assert.equal(JSON.parse(first.lines[first.lines.length - 1]).n, 59);

  const second = await readSessionLines(file, SESSION, null);
  assert.equal(second.lines.length, first.lines.length, 'и во второй раз столько же');
});

test('запрос «всю историю» у обычного файла отдаёт её целиком', async () => {
  forgetTranscriptTail();
  const rows = Array.from({ length: 60 }, (_, i) => JSON.stringify({ sessionId: SESSION, n: i }));
  const file = await makeFile(rows);

  const result = await readSessionLines(file, SESSION, null);
  assert.equal(result.total, 60);
  assert.equal(result.complete, true);
});

/** Кадр, который ИИ посмотрел действием: картинка внутри tool_result. */
function frameRow(session: string, index: number, kb: number): string {
  return JSON.stringify({
    sessionId: session,
    n: index,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: `t${index}`,
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(kb * 1024) } }],
      }],
    },
    toolUseResult: { type: 'image', file: { base64: 'A'.repeat(kb * 1024), type: 'image/png' } },
  });
}

test('кадры в результатах действий не вытесняют начало переписки (22.09.26)', async () => {
  forgetTranscriptTail();
  // 16 кадров по 2×600 КБ — около 19 МБ, больше потолка полного чтения.
  const rows = [row(SESSION, 1), row(SESSION, 2)];
  for (let i = 3; i < 19; i += 1) rows.push(frameRow(SESSION, i, 600));
  rows.push(row(SESSION, 19));
  const file = await makeFile(rows);

  const all = await readSessionLines(file, SESSION, null);
  assert.equal(all.complete, true);
  assert.deepEqual(all.lines.map((l) => JSON.parse(l).n), Array.from({ length: 19 }, (_, i) => i + 1));
  const frame = JSON.parse(all.lines[2]);
  assert.equal(frame.message.content[0].content[0].source.data, '');
  assert.equal(frame.toolUseResult.file.base64, '');

  forgetTranscriptTail();
  await readSessionLines(file, SESSION, 5);
  const deeper = await readSessionLines(file, SESSION, 200);
  assert.equal(deeper.complete, true);
  assert.equal(JSON.parse(deeper.lines[0]).n, 1);
});

test('картинку, которую приложил человек, облегчение не трогает', async () => {
  forgetTranscriptTail();
  const attached = JSON.stringify({
    sessionId: SESSION,
    n: 1,
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(200 * 1024) } }] },
  });
  const file = await makeFile([attached]);
  const all = await readSessionLines(file, SESSION, null);
  assert.equal(JSON.parse(all.lines[0]).message.content[0].source.data.length, 200 * 1024);
});
