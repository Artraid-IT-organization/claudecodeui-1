import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clampProjectProviderModel,
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
