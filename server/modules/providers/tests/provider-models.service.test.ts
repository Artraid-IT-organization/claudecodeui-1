import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderModelsService } from '@/modules/providers/services/provider-models.service.js';
import {
  applyDevinModelAllowlistToCatalog,
  clampDevinModelForUser,
  devinModelAllowlistForUser,
} from '@/modules/providers/services/devin-model-policy.js';
import type {
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const createModels = (value: string): ProviderModelsDefinition => ({
  OPTIONS: [{ value, label: value }],
  DEFAULT: value,
});

const createCurrentActiveModel = (model: string): ProviderCurrentActiveModel => ({ model });

/** In-memory stand-in for the `sessions` table rows the service reads and writes. */
const createSessionStore = (
  rows: Record<string, string | null> = {},
  efforts: Record<string, string | null> = {},
  owners: Record<string, number> = {},
) => {
  const sessions = new Map(Object.entries(rows).map(([sessionId, model]) => [
    sessionId,
    { model, effort: efforts[sessionId] ?? null, initiated_by_user_id: owners[sessionId] ?? null },
  ]));
  return {
    sessions,
    getSessionById: (sessionId: string) =>
      sessions.get(sessionId) ?? null,
    setSessionModel: (sessionId: string, model: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.model = model;
      }
    },
    setSessionEffort: (sessionId: string, effort: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.effort = effort;
      }
    },
  };
};

const createCatalogStore = () => {
  const rows = new Map<LLMProvider, CustomProviderModelRecord[]>();
  let nextRecordId = 1;
  const readRows = (provider: LLMProvider) => rows.get(provider) ?? [];

  return {
    rows,
    listCustomProviderModels(provider: LLMProvider) {
      return [...readRows(provider)];
    },
    getCustomProviderModel(provider: LLMProvider, recordId: number) {
      return readRows(provider).find((record) => record.recordId === recordId) ?? null;
    },
    findCustomProviderModelByModelId(provider: LLMProvider, modelId: string) {
      return readRows(provider).find((record) => record.modelId === modelId) ?? null;
    },
    createCustomProviderModel(provider: LLMProvider, input: CustomProviderModelInput) {
      const record: CustomProviderModelRecord = {
        recordId: nextRecordId++,
        provider,
        modelId: input.id,
        model: input.model,
        sortOrder: readRows(provider).length,
      };
      rows.set(provider, [...readRows(provider), record]);
      return record;
    },
    updateCustomProviderModel(
      provider: LLMProvider,
      recordId: number,
      input: CustomProviderModelInput,
    ) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      const updated = { ...existing, modelId: input.id, model: input.model };
      rows.set(provider, readRows(provider).map((record) => (
        record.recordId === recordId ? updated : record
      )));
      return updated;
    },
    deleteCustomProviderModel(provider: LLMProvider, recordId: number, _fallbackModelId: string) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      rows.set(provider, readRows(provider).filter((record) => record.recordId !== recordId));
      return existing;
    },
  };
};

const createTestService = (options: {
  catalog?: ReturnType<typeof createCatalogStore>;
  sessions?: ReturnType<typeof createSessionStore>;
  activeModel?: (provider: LLMProvider, sessionId?: string) => string;
  onCatalogRead?: (provider: LLMProvider) => void;
} = {}) => {
  const catalog = options.catalog ?? createCatalogStore();
  const sessions = options.sessions ?? createSessionStore();
  const service = createProviderModelsService({
    catalog,
    sessions,
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => {
          options.onCatalogRead?.(provider);
          return createModels(`${provider}-default`);
        },
        getCurrentActiveModel: async (sessionId) => createCurrentActiveModel(
          options.activeModel?.(provider, sessionId) ?? `${provider}-default`,
        ),
      },
    }),
  });

  return { service, catalog, sessions };
};

test('provider catalogs merge source-controlled defaults with custom persistence rows', async () => {
  const calls: LLMProvider[] = [];
  const { service, catalog } = createTestService({ onCatalogRead: (provider) => calls.push(provider) });

  const models = await service.getProviderModels('codex');

  assert.deepEqual(calls, ['codex']);
  assert.equal(models.DEFAULT, 'codex-default');
  assert.deepEqual(models.OPTIONS[0], {
    value: 'codex-default',
    label: 'codex-default',
    isCustom: false,
  });
  assert.deepEqual(catalog.rows.get('codex'), undefined);
});

test('custom models can be created, edited, and deleted', async () => {
  const { service } = createTestService();
  const created = await service.createCustomModel('claude', {
    model: 'My Claude',
    id: 'claude-my-model',
  });
  const recordId = created.model.recordId as number;

  assert.equal(created.model.isCustom, true);
  assert.equal(created.models.OPTIONS.at(-1)?.value, 'claude-my-model');

  const updated = await service.updateCustomModel('claude', recordId, {
    model: 'My Better Claude',
    id: 'claude-my-model-v2',
  });
  assert.equal(updated.model.label, 'My Better Claude');
  assert.equal(updated.model.value, 'claude-my-model-v2');

  const removed = await service.deleteCustomModel('claude', recordId);
  assert.equal(removed.model.value, 'claude-my-model-v2');
  assert.equal(removed.models.OPTIONS.some((option) => option.recordId === recordId), false);
});

test('duplicate model ids are rejected within one provider', async () => {
  const { service } = createTestService();
  await service.createCustomModel('cursor', { model: 'First', id: 'custom-id' });

  await assert.rejects(
    () => service.createCustomModel('cursor', { model: 'Second', id: 'custom-id' }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );

  await assert.rejects(
    () => service.createCustomModel('cursor', {
      model: 'Duplicate built-in',
      id: 'cursor-default',
    }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );
});

test('predefined models have no database record or mutation target', async () => {
  const { service, catalog } = createTestService();
  const models = await service.getProviderModels('opencode');
  assert.equal(models.OPTIONS[0]?.recordId, undefined);
  assert.equal(models.OPTIONS[0]?.isCustom, false);
  assert.deepEqual(catalog.rows.get('opencode'), undefined);

  await assert.rejects(
    () => service.updateCustomModel('opencode', 999, { model: 'Changed', id: 'changed' }),
    (error) => error instanceof AppError && error.code === 'MODEL_NOT_FOUND',
  );
});

test('resolveSessionModel asks the provider adapter for the requested session', async () => {
  const calls: Array<{ provider: LLMProvider; sessionId?: string }> = [];
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-123': null }),
    activeModel: (provider, sessionId) => {
      calls.push({ provider, sessionId });
      return `${provider}-${sessionId}`;
    },
  });

  const resolved = await service.resolveSessionModel('opencode', { sessionId: 'session-123' });

  assert.deepEqual(calls, [{ provider: 'opencode', sessionId: 'session-123' }]);
  assert.equal(resolved.model, 'opencode-session-123');
});

test('setSessionModel records the model on the session row', () => {
  const sessions = createSessionStore({ 'session-1': null });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionModel('claude', 'session-1', 'opus');

  assert.deepEqual(stored, {
    provider: 'claude',
    sessionId: 'session-1',
    model: 'opus',
    effort: null,
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1')?.model, 'opus');
});

test('setSessionModel ignores sessions that have no row yet', () => {
  const sessions = createSessionStore();
  const { service } = createTestService({ sessions });

  assert.equal(service.setSessionModel('claude', 'missing-session', 'opus'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('setSessionEffort records an explicit effort on the session row', () => {
  const sessions = createSessionStore({ 'session-1': 'gpt-5.6-sol' });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionEffort('codex', 'session-1', 'ultra');

  assert.deepEqual(stored, {
    provider: 'codex',
    sessionId: 'session-1',
    effort: 'ultra',
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1')?.effort, 'ultra');
});

test('setSessionEffort ignores sessions that have no row yet', () => {
  const sessions = createSessionStore();
  const { service } = createTestService({ sessions });

  assert.equal(service.setSessionEffort('codex', 'missing-session', 'high'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('resolveSessionModel prefers the recorded session model', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': 'haiku' }, { 'session-1': 'high' }),
    activeModel: () => 'provider-reported',
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'sonnet',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.effort, 'high');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel uses provider session state for unrecorded external sessions', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': null }),
    activeModel: () => 'provider-reported',
  });

  const resolved = await service.resolveSessionModel('opencode', {
    sessionId: 'session-1',
    requestedModel: 'requested',
  });

  assert.equal(resolved.model, 'provider-reported');
  assert.equal(resolved.source, 'provider');
});

test('resolveSessionModel uses the requested model when provider reports the catalog default', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': null }),
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'haiku',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel returns a requested model before a session exists', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('codex', { requestedModel: 'gpt-5.5' });

  assert.equal(resolved.model, 'gpt-5.5');
  assert.equal(resolved.sessionId, null);
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel falls back to the provider adapter default', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('codex');

  assert.equal(resolved.model, 'codex-default');
  assert.equal(resolved.source, 'default');
});

test('resolveResumeModel prefers the recorded session model over the requested one', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-456': 'composer-2' }),
  });

  const model = await service.resolveResumeModel('cursor', 'session-456', 'composer-2-fast');
  assert.equal(model, 'composer-2');
});

test('resolveResumeModel never consults provider-global state', async () => {
  let providerLookups = 0;
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-456': null }),
    activeModel: () => {
      providerLookups += 1;
      return 'global-config-model';
    },
  });

  const model = await service.resolveResumeModel('cursor', 'session-456', 'composer-2-fast');

  assert.equal(model, 'composer-2-fast');
  assert.equal(providerLookups, 0);
});

test('codex: a model the login does not accept falls back to the catalog default', async () => {
  let providerLookups = 0;
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-old': 'gpt-5.4', 'session-new': null }),
    activeModel: () => {
      providerLookups += 1;
      return 'global-config-model';
    },
  });

  // Recorded on the chat before the catalog was narrowed to the login's list.
  assert.equal(await service.resolveResumeModel('codex', 'session-old', 'gpt-5.4'), 'codex-default');
  // A stale client default for a brand-new chat.
  assert.equal(await service.resolveResumeModel('codex', undefined, 'gpt-5.4'), 'codex-default');
  // A usable requested model is kept.
  assert.equal(await service.resolveResumeModel('codex', 'session-new', 'codex-default'), 'codex-default');
  // The label the composer shows matches what runs.
  const shown = await service.resolveSessionModel('codex', { sessionId: 'session-old' });
  assert.equal(shown.model, 'codex-default');
  assert.equal(shown.source, 'session');
  assert.equal(providerLookups, 0);
});


test('devinModelAllowlistForUser restricts only the listed accounts', () => {
  assert.deepEqual([...devinModelAllowlistForUser(110) ?? []].sort(), [
    'swe-2-high',
    'swe-2-max',
    'swe-2-medium',
  ]);
  assert.equal(devinModelAllowlistForUser(1), null);
  assert.equal(devinModelAllowlistForUser('110') !== null, true);
  assert.equal(devinModelAllowlistForUser(null), null);
});

test('clampDevinModelForUser swaps disallowed models for the restricted default', () => {
  assert.equal(clampDevinModelForUser('devin', 110, 'swe-2-max'), 'swe-2-max');
  assert.equal(clampDevinModelForUser('devin', 110, 'swe-1.7'), 'swe-2-high');
  assert.equal(clampDevinModelForUser('devin', 110, undefined), 'swe-2-high');
  assert.equal(clampDevinModelForUser('devin', 1, 'swe-1.7'), 'swe-1.7');
  assert.equal(clampDevinModelForUser('codex', 110, 'gpt-5.5'), 'gpt-5.5');
});

test('applyDevinModelAllowlistToCatalog filters the picker down to the allowlist', () => {
  const catalog: ProviderModelsDefinition = {
    OPTIONS: [
      { value: 'swe-2-high', label: 'High' },
      { value: 'swe-2-medium', label: 'SWE Medium' },
      { value: 'swe-2-max', label: 'Max' },
      { value: 'swe-1.7', label: 'SWE 1.7' },
      { value: 'adaptive', label: 'Adaptive' },
    ],
    DEFAULT: 'adaptive',
  };

  const restricted = applyDevinModelAllowlistToCatalog('devin', 110, catalog);
  assert.deepEqual(restricted.OPTIONS.map((option) => option.value), [
    'swe-2-high',
    'swe-2-medium',
    'swe-2-max',
  ]);
  assert.equal(restricted.DEFAULT, 'swe-2-high');

  const unrestricted = applyDevinModelAllowlistToCatalog('devin', 1, catalog);
  assert.equal(unrestricted.OPTIONS.length, 5);
  assert.equal(unrestricted.DEFAULT, 'adaptive');
});

test('setSessionModel clamps a disallowed model on a restricted owner session', () => {
  const sessions = createSessionStore({ 'session-110': null }, {}, { 'session-110': 110 });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionModel('devin', 'session-110', 'swe-1.7');

  assert.equal(stored?.model, 'swe-2-high');
  assert.equal(sessions.sessions.get('session-110')?.model, 'swe-2-high');
});

test('setSessionModel keeps the requested model for unrestricted owners', () => {
  const sessions = createSessionStore({ 'session-1': null }, {}, { 'session-1': 1 });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionModel('devin', 'session-1', 'swe-1.7');

  assert.equal(stored?.model, 'swe-1.7');
  assert.equal(sessions.sessions.get('session-1')?.model, 'swe-1.7');
});

test('resolveResumeModel clamps the recorded model of a restricted owner session', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-110': 'swe-1.7' }, {}, { 'session-110': 110 }),
  });

  const model = await service.resolveResumeModel('devin', 'session-110', 'swe-2-max');
  assert.equal(model, 'swe-2-high');
});

test('resolveSessionModel clamps the requested model for a restricted caller', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('devin', {
    requestedModel: 'swe-1.7',
    userId: 110,
  });

  assert.equal(resolved.model, 'swe-2-high');
});

test('resolveSessionModel clamps the catalog default for a restricted caller', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('devin', { userId: 110 });

  assert.equal(resolved.model, 'swe-2-high');
  assert.equal(resolved.source, 'default');
});
