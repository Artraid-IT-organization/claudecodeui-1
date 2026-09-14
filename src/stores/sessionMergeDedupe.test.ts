import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import { isLongReplyAlreadyOnServer } from './sessionMessageReconciliation';

const msg = (id: string, over: Partial<NormalizedMessage>): NormalizedMessage => ({
  id, sessionId: 's1', timestamp: '2026-09-14T13:08:18.000Z', provider: 'claude', kind: 'text', role: 'assistant', content: '', ...over,
});

const REPLY = 'Как я понял задачу. Нужен документ, который за полчаса-час объяснит вам всю финансовую систему.';

test('живая копия длинного ответа узнаётся на диске в любом месте переписки', () => {
  // Снимок Егора 14.09.26: ответ встал второй раз ниже, через «Ход работы» и
  // другой ответ. На диске между сообщением человека и ответом было служебное
  // уведомление, и сверка «в том же ходе» искала не тот ход.
  const server = [
    msg('u1', { role: 'user', content: 'Сделай документ по финансам' }),
    msg('n1', { role: 'user', content: '<task-notification>готово</task-notification>' }),
    msg('a1', { content: REPLY }),
    msg('t1', { kind: 'tool_use', toolName: 'Bash', toolId: 'tool-1' }),
    msg('a2', { content: 'Три правки внесены. Пересобираю документ и снова проверяю вёрстку.' }),
  ];
  assert.equal(isLongReplyAlreadyOnServer(msg('live-a1', { content: `  ${REPLY}\n` }), server), true);
});

test('короткие и отличающиеся ответы копией не считаются', () => {
  const server = [msg('a1', { content: 'Готово.' }), msg('a2', { content: REPLY })];
  assert.equal(isLongReplyAlreadyOnServer(msg('live', { content: 'Готово.' }), server), false, 'короткий повтор может быть настоящим');
  assert.equal(isLongReplyAlreadyOnServer(msg('live', { content: `${REPLY} И ещё строка.` }), server), false);
  assert.equal(isLongReplyAlreadyOnServer(msg('live', { content: REPLY }), [msg('u', { role: 'user', content: REPLY })]), false, 'текст человека — не ответ');
});
