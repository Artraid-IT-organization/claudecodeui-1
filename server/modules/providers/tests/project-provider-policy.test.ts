import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clampProjectProviderModel,
  resolvePinnedSessionProvider,
  resolveProjectProvider,
} from '../services/project-provider-policy.js';

const PINNED_PATH = '/home/claude/prompts';
const OTHER_PATH = '/home/claude/other';

describe('resolveProjectProvider', () => {
  it('заменяет провайдера на привязанного для закреплённого проекта', () => {
    assert.equal(resolveProjectProvider(PINNED_PATH, 'devin'), 'claude');
    assert.equal(resolveProjectProvider(PINNED_PATH, 'claude'), 'claude');
  });

  it('не трогает провайдера вне привязанных проектов', () => {
    assert.equal(resolveProjectProvider(OTHER_PATH, 'devin'), 'devin');
    assert.equal(resolveProjectProvider('', 'devin'), 'devin');
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
