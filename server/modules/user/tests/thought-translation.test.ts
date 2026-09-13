import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTranslationPrompt, isTitleStubOnly, parseTranslations, translateThoughts } from '../thought-translation.js';

test('пустышкой считается только файл из одних заголовков', () => {
  assert.equal(isTitleStubOnly('{"type":"ai-title","aiTitle":"Перевод","sessionId":"x"}\n'), true);
  assert.equal(isTitleStubOnly('{"type":"ai-title","aiTitle":"a"}\n{"type":"user","message":{}}\n'), false);
  assert.equal(isTitleStubOnly(''), false);
  assert.equal(isTitleStubOnly('не json'), false);
});

test('ответ модели разбирается, в том числе в обёртке ```json', () => {
  assert.deepEqual(parseTranslations('["Проверяю вход", "Готово"]', 2), ['Проверяю вход', 'Готово']);
  assert.deepEqual(parseTranslations('```json\n["Один"]\n```', 1), ['Один']);
});

test('не тот размер или пустые строки — не перевод', () => {
  assert.equal(parseTranslations('["Один"]', 2), null);
  assert.equal(parseTranslations('["", "Два"]', 2), null);
  assert.equal(parseTranslations('Вот перевод: ...', 1), null);
});

test('в запросе к модели — все фрагменты по порядку и просьба вернуть массив', () => {
  const prompt = buildTranslationPrompt(['first thought', 'second thought']);
  assert.match(prompt, /JSON-массивом из 2 строк/);
  assert.ok(prompt.includes('["first thought","second thought"]'));
});

test('русские мысли возвращаются без обращения к модели', async () => {
  const text = 'Проверяю, дошла ли правка до сайта, и смотрю снимок.';
  assert.deepEqual(await translateThoughts([text], null), [text]);
  assert.deepEqual(await translateThoughts('не массив', null), []);
});
