import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDigestPrompt, digestThoughts, isTitleStubOnly, parseDigest } from '../thought-translation.js';

test('пустышкой считается только файл из одних заголовков', () => {
  assert.equal(isTitleStubOnly('{"type":"ai-title","aiTitle":"Перевод","sessionId":"x"}\n'), true);
  assert.equal(isTitleStubOnly('{"type":"ai-title","aiTitle":"a"}\n{"type":"user","message":{}}\n'), false);
  assert.equal(isTitleStubOnly(''), false);
  assert.equal(isTitleStubOnly('не json'), false);
});

test('разбор ответа модели: этапы с русским текстом, мелочи без текста', () => {
  assert.deepEqual(
    parseDigest('[{"keep": true, "ru": "Исследование закончено: причина в кэше"}, {"keep": false}]', 2),
    [{ keep: true, ru: 'Исследование закончено: причина в кэше' }, { keep: false, ru: null }],
  );
  assert.deepEqual(parseDigest('```json\n[{"keep": false, "ru": "лишнее"}]\n```', 1), [{ keep: false, ru: null }]);
});

test('кривой ответ модели — не разбор', () => {
  assert.equal(parseDigest('[{"keep": true}]', 1), null, 'этап без текста');
  assert.equal(parseDigest('[{"keep": false}]', 2), null, 'не тот размер');
  assert.equal(parseDigest('[{"ru": "без решения"}]', 1), null);
  assert.equal(parseDigest('Вот разбор: ...', 1), null);
});

test('в запросе к модели — все фрагменты по порядку, признаки этапа и формат ответа', () => {
  const prompt = buildDigestPrompt(['research done', 'reading file']);
  assert.ok(prompt.includes('["research done","reading file"]'));
  assert.match(prompt, /JSON-массивом из 2 элементов/);
  assert.match(prompt, /критика/);
});

test('пустой и неверный ввод модель не вызывает', async () => {
  assert.deepEqual(await digestThoughts('не массив', null), []);
  assert.deepEqual(await digestThoughts(['', '   '], null), [null, null]);
});
