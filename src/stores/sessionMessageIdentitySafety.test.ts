import assert from 'node:assert/strict';
import test from 'node:test';

import { computeMerged } from './sessionMessageReconciliation';
import type { NormalizedMessage } from './useSessionStore';

const msg = (id: string, timestamp: string, content: string, role: 'user' | 'assistant' = 'assistant'): NormalizedMessage => ({
  id, sessionId: 'identity-safety', timestamp, content, role, kind: 'text', provider: 'claude',
});

for (const reply of ['Да, собрано.', 'Результат проверки: все три сервиса поднялись, лог чистый, ошибок нет.']) {
  test(`новый ход сохраняет самостоятельный одинаковый ответ длиной ${reply.length}`, () => {
    const server = [
      msg('u1', '2026-10-20T02:00:00.000Z', 'Первый запрос', 'user'),
      msg('a1', '2026-10-20T02:00:10.000Z', reply),
    ];
    const realtime = [
      msg('local_second', '2026-10-20T02:00:50.000Z', 'Второй запрос', 'user'),
      msg('live_second', '2026-10-20T02:01:00.000Z', reply),
    ];
    const actual = computeMerged(server, realtime).filter((m) => m.role === 'assistant' && m.kind === 'text');
    assert.deepEqual(actual.map((m) => m.id), ['a1', 'live_second']);
  });
}

test('разные сохранённые ответы с одинаковым текстом не удаляются из отображения', () => {
  const reply = 'Все три сервиса поднялись, смотрю дальше.';
  const server: NormalizedMessage[] = [
    msg('u1', '2026-10-20T02:00:00.000Z', 'Проверь два раза', 'user'),
    msg('a1', '2026-10-20T02:00:10.000Z', reply),
    { ...msg('tool1', '2026-10-20T02:00:20.000Z', ''), kind: 'tool_use', toolId: 'check2', toolName: 'Bash' },
    msg('a2', '2026-10-20T02:00:30.000Z', reply),
  ];
  assert.deepEqual(computeMerged(server, []).filter((m) => m.role === 'assistant' && m.kind === 'text').map((m) => m.id), ['a1', 'a2']);
});
