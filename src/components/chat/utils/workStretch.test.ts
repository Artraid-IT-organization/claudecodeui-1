import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';
import { isToolGroupItem } from './toolGrouping';
import { describeWorkStretch, groupWorkStretches, isWorkStretchItem, workStretchRows } from './workStretch';

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

test('раскрытый ход работы показывает ключевые мысли между действиями', () => {
  const items = groupWorkStretches([
    user('почини', 1), tool('Bash', 2), think(LONG, 3), tool('Bash', 4), think('жду', 5), tool('Bash', 6), reply('Готово.', 7),
  ]);
  const stretch = items[1] as Extract<(typeof items)[number], { _isStretch: true }>;
  const rows = workStretchRows(stretch);
  const thoughts = rows.filter((row) => !isToolGroupItem(row) && row.isThinking);
  assert.equal(thoughts.length, 1, 'ключевая мысль должна остаться видимой');
  assert.equal(rows.length, 3, 'действие · мысль · два действия подряд одной строкой');
});

test('ошибки действий видны в свёрнутой строке', () => {
  const failed: ChatMessage = { ...tool('Bash', 3), toolResult: { content: 'boom', isError: true } as ChatMessage['toolResult'] };
  const items = groupWorkStretches([user('a', 1), tool('Read', 2), failed, reply('Не вышло.', 4)]);
  const stretch = items[1] as Extract<(typeof items)[number], { _isStretch: true }>;
  assert.equal(stretch.errorCount, 1);
  assert.equal(describeWorkStretch(stretch), 'Ход работы · 2 действия · 1 ошибка');
});

test('план на утверждение и вопрос с вариантами не прячутся в свёртку', () => {
  const items = groupWorkStretches([user('a', 1), tool('Read', 2), tool('ExitPlanMode', 3), tool('Bash', 4), tool('AskUserQuestion', 5)]);
  const visibleTools = items.filter((item) => !isWorkStretchItem(item) && item.isToolUse).map((item) => (item as ChatMessage).toolName);
  assert.deepEqual(visibleTools, ['ExitPlanMode', 'AskUserQuestion']);
});

const EN = "I've created a branch from the clean head and I'm starting to build a private list of how message types are handled.";

test('английская внутренняя кухня в ключевые мысли не попадает', () => {
  const items = groupWorkStretches([user('a', 1), think(EN, 2), tool('Bash', 3), think(LONG, 4), reply('Готово.', 5)]);
  const stretch = items[1] as Extract<(typeof items)[number], { _isStretch: true }>;
  assert.equal(stretch.keyThoughts.length, 1);
  assert.equal(stretch.keyThoughts[0].content, LONG);
  assert.equal(describeWorkStretch(stretch), 'Ход работы · 1 мысль · 1 действие');
});

test('показываются не больше трёх последних русских мыслей', () => {
  const msgs = [user('a', 1)];
  for (let i = 0; i < 6; i += 1) { msgs.push(think(`${LONG} Шаг ${i}.`, 2 + i)); msgs.push(tool('Bash', 20 + i)); }
  msgs.push(reply('Готово.', 40));
  const items = groupWorkStretches(msgs);
  const stretch = items[1] as Extract<(typeof items)[number], { _isStretch: true }>;
  assert.equal(stretch.keyThoughts.length, 3);
  assert.match(String(stretch.keyThoughts[2].content), /Шаг 5/);
  const shown = workStretchRows(stretch).filter((row) => !isToolGroupItem(row) && row.isThinking);
  assert.equal(shown.length, 3);
});
