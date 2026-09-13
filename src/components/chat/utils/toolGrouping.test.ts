import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';
import { groupConsecutiveTools, isEmptyThinking, isToolGroupItem } from './toolGrouping';

const bash = (id: string): ChatMessage => ({
  type: 'assistant',
  timestamp: `2026-09-13T10:00:0${id}Z`,
  isToolUse: true,
  toolName: 'Bash',
  toolId: id,
});

const thinking = (content: string): ChatMessage => ({
  type: 'assistant',
  timestamp: '2026-09-13T10:00:00Z',
  isThinking: true,
  content,
});

test('пустой блок размышления распознаётся как пустой', () => {
  assert.equal(isEmptyThinking(thinking('')), true);
  assert.equal(isEmptyThinking(thinking('   \n ')), true);
  assert.equal(isEmptyThinking(thinking('Проверю версию nginx')), false);
  assert.equal(isEmptyThinking(bash('1')), false);
});

test('пустые размышления между командами не рвут их в отдельные строки', () => {
  const items = groupConsecutiveTools([bash('1'), thinking(''), bash('2'), thinking(''), bash('3')], true);
  const groups = items.filter(isToolGroupItem);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].messages.length, 3);
});

test('размышление с текстом по-прежнему разделяет команды', () => {
  const items = groupConsecutiveTools([bash('1'), thinking('Смотрю логи'), bash('2')], true);
  assert.equal(items.filter(isToolGroupItem).length, 2);
});
