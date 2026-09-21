import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDigestPrompt, createGate, digestThoughts, echoMatches, isTitleStubOnly, parseDigest } from '../thought-translation.js';

test('пустышкой считается только файл из одних заголовков', () => {
  assert.equal(isTitleStubOnly('{"type":"ai-title","aiTitle":"Перевод","sessionId":"x"}\n'), true);
  assert.equal(isTitleStubOnly('{"type":"ai-title","aiTitle":"a"}\n{"type":"user","message":{}}\n'), false);
  assert.equal(isTitleStubOnly(''), false);
  assert.equal(isTitleStubOnly('не json'), false);
});

const RESEARCH = 'Research is done: the cache key ignores the user id.';
const READING = 'Reading the config file next.';

test('разбор ответа модели: этапы с русским текстом, мелочи без текста', () => {
  assert.deepEqual(
    parseDigest(
      '[{"id": 0, "start": "Research is done", "keep": true, "ru": "Исследование закончено: ключ кэша не учитывает пользователя"}, {"id": 1, "start": "Reading the config", "keep": false}]',
      [RESEARCH, READING],
    ),
    [{ keep: true, ru: 'Исследование закончено: ключ кэша не учитывает пользователя' }, { keep: false, ru: null }],
  );
  assert.deepEqual(
    parseDigest('```json\n[{"id": 0, "start": "Reading the config", "keep": false, "ru": "лишнее"}]\n```', [READING]),
    [{ keep: false, ru: null }],
  );
});

test('ответы сверяются по номеру: пропуск и перестановка не сдвигают переводы', () => {
  // Замер 14.09.26: на пачку из 20 Haiku вернула 17 элементов.
  const third = 'Found the cause in the session watcher.';
  const raw = `[{"id": 2, "start": "Found the cause", "keep": true, "ru": "Нашёл причину"}, {"id": 0, "start": "Research is done", "keep": false}]`;
  assert.deepEqual(parseDigest(raw, [RESEARCH, READING, third]), [{ keep: false, ru: null }, null, { keep: true, ru: 'Нашёл причину' }]);
});

test('ответ, чьё начало не совпадает с мыслью, не принимается', () => {
  // Защита от путаницы номеров и от перевода без начала (замер 14.09.26:
  // у мысли «сборка идёт в фоне… поле поиска не видно» потерялась первая половина).
  const raw = '[{"id": 0, "start": "The sidebar apparently", "keep": true, "ru": "Проверка не удалась — поле поиска не видно"}]';
  assert.deepEqual(parseDigest(raw, ['The build is running in the background and will restart soon.']), [null]);
  assert.equal(echoMatches('The build is running', 'the build is'), true);
  assert.equal(echoMatches('Сначала изучу код поля', 'Сначала изучу код'), true);
  assert.equal(echoMatches('The build is running', undefined), false);
});

test('кривой ответ модели — не разбор', () => {
  assert.deepEqual(parseDigest('[{"id": 0, "start": "Research is done", "keep": true}]', [RESEARCH]), [null], 'этап без текста');
  assert.deepEqual(parseDigest('[{"id": 7, "start": "Research is done", "keep": false}]', [RESEARCH, READING]), [null, null], 'номер вне пачки');
  assert.deepEqual(parseDigest('[{"start": "Research is done", "keep": false}]', [RESEARCH]), [null], 'без номера');
  assert.equal(parseDigest('Вот разбор: ...', [RESEARCH]), null);
});

test('в запросе к модели — фрагменты с номерами, признаки этапа и формат ответа', () => {
  const prompt = buildDigestPrompt(['research done', 'reading file']);
  assert.ok(prompt.includes('[{"id":0,"text":"research done"},{"id":1,"text":"reading file"}]'));
  assert.match(prompt, /по одному элементу на КАЖДЫЙ id/);
  assert.match(prompt, /первые три слова ЭТОГО фрагмента/);
  assert.match(prompt, /критика/);
  assert.match(prompt, /на этом закончил/);
});

test('пустой и неверный ввод модель не вызывает', async () => {
  assert.deepEqual(await digestThoughts('не массив', null), []);
  assert.deepEqual(await digestThoughts(['', '   '], null), [null, null]);
});

test('пропускной пункт: больше потолка разом не пускает, остальные ждут очереди', async () => {
  // 21.09.26: без потолка один открытый экран нарастил 43 процесса CLI и
  // положил службу целиком.
  const gate = createGate(2);
  let running = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const jobs = Array.from({ length: 5 }, () =>
    gate(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
      return true;
    }),
  );

  // Дать очереди разобраться и отпускать работы по одной.
  for (let step = 0; step < 5; step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    release.shift()?.();
  }
  await new Promise((resolve) => setImmediate(resolve));
  release.forEach((done) => done());
  assert.deepEqual(await Promise.all(jobs), [true, true, true, true, true]);
  assert.equal(peak, 2);
});

test('брошенный запрос в модель не идёт: отмена до разбора отдаёт пустые места', async () => {
  // Браузер закрыл запрос — считать больше некому. Мысль заведомо не из кэша:
  // если бы разбор всё же пошёл, тест ушёл бы в запуск модели и упал по времени.
  const abandoned = AbortSignal.abort();
  const fresh = `Thought that was never digested ${Date.now()}`;
  assert.deepEqual(await digestThoughts([fresh], null, abandoned), [null]);
});
