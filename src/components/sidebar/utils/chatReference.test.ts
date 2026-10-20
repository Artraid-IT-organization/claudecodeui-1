import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatChatReference } from './chatReference';
import type { LLMProvider } from '../../../types/app';

for (const provider of ['claude', 'devin', 'codex', 'cursor', 'opencode'] as LLMProvider[]) {
  test(`chat reference preserves both complete identifiers for ${provider}`, () => {
    const sessionId = '4bc568c7-b376-47b6-aa71-c3317f6c6cb6';
    const providerSessionId = 'tide-christmas-0123456789abcdef';
    const result = formatChatReference({
      origin: 'http://127.0.0.1:3419',
      project: { projectId: 'project-123', fullPath: '/tmp/fictional-project' },
      sessionId, provider, providerSessionId,
    });
    assert.ok(result.includes(`ID чата: ${sessionId}\n`));
    assert.ok(result.includes(`ID сессии ${provider}: ${providerSessionId}\n`));
    assert.ok(result.includes('Чат на сервере: http://127.0.0.1:3419\n'));
    assert.ok(result.includes('Проект: /tmp/fictional-project\n'));
    assert.ok(result.includes('ID проекта: project-123\n'));
  });
}

test('chat remains identifiable before a provider ID is assigned', () => {
  const result = formatChatReference({
    origin: 'http://127.0.0.1:3419',
    project: { projectId: 'project-123', fullPath: '/tmp/fictional-project' },
    sessionId: 'full-app-session-id', provider: 'devin', providerSessionId: null,
  });
  assert.ok(result.includes('ID чата: full-app-session-id\n'));
  assert.ok(!result.includes('\nID сессии'));
  assert.ok(!result.includes('null'));
});
