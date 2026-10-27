import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clampProjectProviderModel,
  resolvePinnedProjectBrain,
  resolvePinnedSessionProvider,
} from '../services/project-provider-policy.js';

const PINNED_PATH = '/home/claude/prompts';
const OTHER_PATH = '/home/claude/other';

describe('resolvePinnedProjectBrain', () => {
  it('наследует последнюю использованную пару помощник+модель папки', () => {
    assert.deepEqual(
      resolvePinnedProjectBrain(PINNED_PATH, 'devin', { provider: 'claude', model: 'sonnet' }),
      { provider: 'claude', model: 'sonnet' },
    );
    assert.deepEqual(
      resolvePinnedProjectBrain(PINNED_PATH, 'devin', { provider: 'devin', model: 'swe-2-high' }),
      { provider: 'devin', model: 'swe-2-high' },
    );
  });

  it('без истории или при чужом наследстве — умолчание папки Claude Opus, а у чужого проекта запрошенный провайдер', () => {
    assert.deepEqual(
      resolvePinnedProjectBrain(PINNED_PATH, 'devin', null),
      { provider: 'claude', model: 'opus' },
    );
    assert.deepEqual(
      resolvePinnedProjectBrain(PINNED_PATH, 'devin', { provider: 'codex', model: 'x' }),
      { provider: 'claude', model: 'opus' },
    );
    assert.deepEqual(
      resolvePinnedProjectBrain(OTHER_PATH, 'devin', { provider: 'claude', model: 'sonnet' }),
      { provider: 'devin', model: null },
    );
  });

  it('отбрасывает модель, недопустимую для унаследованного помощника', () => {
    assert.deepEqual(
      resolvePinnedProjectBrain(PINNED_PATH, 'devin', { provider: 'claude', model: 'swe-2-high' }),
      { provider: 'claude', model: null },
    );
    assert.deepEqual(
      resolvePinnedProjectBrain(PINNED_PATH, 'devin', { provider: 'claude', model: null }),
      { provider: 'claude', model: null },
    );
  });
});

describe('clampProjectProviderModel', () => {
  it('заменяет модель чужого провайдера запасной моделью привязки', () => {
    assert.equal(clampProjectProviderModel('claude', PINNED_PATH, 'swe-2-high'), 'opus');
    assert.equal(clampProjectProviderModel('claude', PINNED_PATH, null), 'opus');
    assert.equal(clampProjectProviderModel('claude', PINNED_PATH, ''), 'opus');
  });

  it('пропускает осознанный выбор допустимой модели claude', () => {
    assert.equal(clampProjectProviderModel('claude', PINNED_PATH, 'sonnet'), 'sonnet');
    assert.equal(clampProjectProviderModel('claude', PINNED_PATH, 'default'), 'default');
    assert.equal(clampProjectProviderModel('claude', PINNED_PATH, 'opus[1m]'), 'opus[1m]');
  });

  it('не трогает модель вне привязки или при другом провайдере сессии', () => {
    assert.equal(clampProjectProviderModel('claude', OTHER_PATH, 'swe-2-high'), 'swe-2-high');
    assert.equal(clampProjectProviderModel('devin', PINNED_PATH, 'swe-2-high'), 'swe-2-high');
    assert.equal(clampProjectProviderModel('claude', null, 'swe-2-high'), 'swe-2-high');
  });
});

describe('resolvePinnedSessionProvider', () => {
  it('переключает привязанный чат на явно выбранного помощника из пары claude|devin', () => {
    assert.equal(resolvePinnedSessionProvider(PINNED_PATH, 'claude', 'devin'), 'devin');
    assert.equal(resolvePinnedSessionProvider(PINNED_PATH, 'devin', 'claude'), 'claude');
  });

  it('отклоняет того же провайдера, чужие значения и непривязанный проект', () => {
    assert.equal(resolvePinnedSessionProvider(PINNED_PATH, 'claude', 'claude'), null);
    assert.equal(resolvePinnedSessionProvider(PINNED_PATH, 'claude', 'codex'), null);
    assert.equal(resolvePinnedSessionProvider(PINNED_PATH, 'claude', 'bogus'), null);
    assert.equal(resolvePinnedSessionProvider(PINNED_PATH, 'claude', null), null);
    assert.equal(resolvePinnedSessionProvider(OTHER_PATH, 'claude', 'devin'), null);
    assert.equal(resolvePinnedSessionProvider(null, 'claude', 'devin'), null);
  });
});
