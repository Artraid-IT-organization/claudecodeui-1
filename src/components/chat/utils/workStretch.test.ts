import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';
import { describeWorkStretch, groupWorkStretches, isWorkStretchItem } from './workStretch';

const at = (n: number) => `2026-09-13T10:00:${String(n).padStart(2, '0')}Z`;
const user = (text: string, n = 0): ChatMessage => ({ type: 'user', content: text, timestamp: at(n) });
const reply = (text: string, n = 0): ChatMessage => ({ type: 'assistant', content: text, timestamp: at(n) });
const think = (text: string, n = 0): ChatMessage => ({ type: 'assistant', isThinking: true, content: text, timestamp: at(n) });
const tool = (name: string, n = 0): ChatMessage => ({ type: 'assistant', isToolUse: true, toolName: name, timestamp: at(n) });
const LONG = 'Причина в том, что счётчик событий не сбрасывается между работами, поэтому вкладка теряет сигнал «думает».';

test('вся работа между сообщением и ответом — один элемент', () => {
  const items = groupWorkStretches([
    user('почини', 1), think(LONG, 2), tool('Bash', 3), think('жду', 4), tool('Read', 5), tool('Bash', 6), reply('Готово, проверил на сайте.', 7),
  ]);
  assert.equal(items.length, 3);
  assert.equal(isWorkStretchItem(items[1]), true);
  const stretch = items[1] as Extract<(typeof items)[number], { _isStretch: true }>;
  assert.equal(stretch.actionCount, 3);
  assert.equal(stretch.keyThoughts.length, 1, 'короткое «жду» — не ключевая мысль');
  assert.equal(stretch.messages.length, 5);
});

test('ответ и сообщение человека не прячутся в свёртку', () => {
  const items = groupWorkStretches([user('a', 1), reply('ответ', 2), user('b', 3)]);
  assert.equal(items.filter(isWorkStretchItem).length, 0);
  assert.equal(items.length, 3);
});

test('только пустые размышления не дают ни строки', () => {
  const items = groupWorkStretches([user('a', 1), think('', 2), think('  ', 3), reply('ответ', 4)]);
  assert.equal(items.filter(isWorkStretchItem).length, 0);
  assert.equal(items.length, 2);
});

test('подпись строки по-русски и с правильными окончаниями', () => {
  assert.equal(describeWorkStretch({ keyThoughts: [think(LONG)], actionCount: 1 }), 'Ход работы · 1 мысль · 1 действие');
  assert.equal(describeWorkStretch({ keyThoughts: [think(LONG), think(LONG), think(LONG)], actionCount: 12 }), 'Ход работы · 3 мысли · 12 действий');
  assert.equal(describeWorkStretch({ keyThoughts: [], actionCount: 5 }), 'Ход работы · 5 действий');
});
