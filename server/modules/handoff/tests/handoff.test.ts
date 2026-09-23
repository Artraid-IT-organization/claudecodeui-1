import assert from 'node:assert/strict';
import test from 'node:test';

import { digestTranscriptLines } from '@/modules/handoff/handoff-digest.js';
import { writeBrief } from '@/modules/handoff/handoff.service.js';

const SID = '11111111-2222-3333-4444-555555555555';
const line = (entry: Record<string, unknown>) => JSON.stringify({ sessionId: SID, timestamp: '2026-09-23T10:00:00Z', ...entry });

test('разбор берёт слова человека и ответы, отбрасывает служебное', () => {
  const digest = digestTranscriptLines([
    line({ type: 'user', message: { content: 'Сделай кнопку <system-reminder>правила хука</system-reminder>' } }),
    line({ type: 'user', message: { content: '<task-notification> фон закончил' } }),
    line({ type: 'user', isMeta: true, message: { content: 'служебное' } }),
    line({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'черновик мыслей' },
      { type: 'text', text: 'Готово, кнопка стоит.' },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.ts' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.ts' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/p/b.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm run build', description: 'Собираю сайт' } },
    ] } }),
    line({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', is_error: true, content: 'build failed: heap' }] } }),
    line({ type: 'user', sessionId: 'другой-разговор', message: { content: 'чужое' } }),
  ], SID);

  assert.match(digest.text, /ЧЕЛОВЕК: Сделай кнопку$/m);
  assert.doesNotMatch(digest.text, /правила хука|фон закончил|служебное|черновик мыслей|чужое|b\.ts/);
  assert.match(digest.text, /АГЕНТ: Готово, кнопка стоит\./);
  assert.equal(digest.text.match(/правка файла \/p\/a\.ts/g)?.length, 1, 'одинаковые действия подряд — одной строкой');
  assert.match(digest.text, /команда: Собираю сайт/);
  assert.match(digest.text, /ошибка: build failed: heap/);
  assert.deepEqual(digest.changedFiles, ['/p/a.ts']);
  assert.equal(digest.humanMessages, 1);
});

test('после сжатия: до сводки — только слова человека, сводка и всё после — целиком', () => {
  const digest = digestTranscriptLines([
    line({ type: 'user', message: { content: 'ранняя просьба' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ранний ответ' }] } }),
    line({ type: 'user', isCompactSummary: true, message: { content: 'СВОДКА: делали кнопку' } }),
    line({ type: 'user', message: { content: 'поздняя просьба' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'поздний ответ' }] } }),
  ], SID);

  assert.equal(digest.hadCompaction, true);
  assert.match(digest.text, /ранняя просьба/);
  assert.doesNotMatch(digest.text, /ранний ответ/);
  assert.match(digest.text, /СВОДКА: делали кнопку/);
  assert.match(digest.text, /поздний ответ/);
});

test('короткая переписка — один вызов модели', async () => {
  const prompts: string[] = [];
  const brief = await writeBrief('ЧЕЛОВЕК: привет', '/acc', async (prompt) => {
    prompts.push(prompt);
    return '## Цель\nx';
  });
  assert.equal(brief, '## Цель\nx');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /<transcript>\nЧЕЛОВЕК: привет\n<\/transcript>/);
});

test('длинная переписка — части, затем сводка с последней частью целиком', async () => {
  const block = `\nЧЕЛОВЕК: ${'а'.repeat(59_990)}`;
  const digest = block.repeat(12); // ≈ 720 тыс. знаков
  const prompts: string[] = [];
  await writeBrief(digest, '/acc', async (prompt) => {
    prompts.push(prompt);
    return prompt.includes('<notes') ? 'итог' : `заметки ${prompts.length}`;
  });
  const maps = prompts.filter((prompt) => prompt.includes('Это часть'));
  const reduces = prompts.filter((prompt) => prompt.includes('<transcript part="last">'));
  assert.ok(maps.length >= 2, `частей ${maps.length}`);
  assert.equal(reduces.length, 1);
  assert.equal(prompts[prompts.length - 1], reduces[0], 'сводка — последним вызовом');
  assert.match(reduces[0], /<notes part="1">/);
});

test('опись вырезается, ссылки входа и ключи скрываются, линии --- убираются', async () => {
  const brief = await writeBrief('ЧЕЛОВЕК: привет', '/acc', async () => [
    '<опись>\n- черновик описи\n</опись>',
    '---',
    '## Цель',
    'Сайт: https://cc.example.ru/enter/nMsKcj_ooYAWE4bhfdzm8A, ключ sk-ant-abcdefghijklmnopqrstuv',
    '---',
    '## Следующий шаг',
    'ждать',
  ].join('\n'));
  assert.doesNotMatch(brief, /опись|черновик|nMsKcj|abcdefghijkl|^---$/m);
  assert.match(brief, /^## Цель/);
  assert.match(brief, /enter\/\[скрыто\]/);
  assert.match(brief, /\[ключ скрыт\]/);
});
