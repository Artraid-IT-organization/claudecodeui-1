import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOfficialUsage } from '../official-usage.js';

// Урезанный настоящий ответ api/oauth/usage, снятый 13.09.26.
const SAMPLE = {
  five_hour: { utilization: 47.0, resets_at: '2026-09-13T22:30:00.509088+00:00' },
  limits: [
    { kind: 'session', group: 'session', percent: 47, severity: 'normal', resets_at: '2026-09-13T22:30:00.509088+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 45, severity: 'normal', resets_at: '2026-09-18T20:00:00.509109+00:00', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 10, severity: 'normal', resets_at: '2026-09-18T19:59:59Z', scope: { model: { id: null, display_name: 'Fable' } } },
  ],
};

test('проценты и сброс берутся из ответа как есть', () => {
  const now = Date.parse('2026-09-13T20:00:00Z');
  const parsed = parseOfficialUsage(SAMPLE, now);
  assert.ok(parsed);
  assert.equal(parsed.fetchedAtMs, now);
  assert.deepEqual(
    parsed.limits.map((limit) => [limit.kind, limit.percent, limit.expired]),
    [['session', 47, false], ['weekly_all', 45, false], ['weekly_scoped', 10, false]],
  );
  assert.equal(parsed.limits[2].modelName, 'Fable');
});

test('окно, которое уже сбросилось, помечается', () => {
  const parsed = parseOfficialUsage(SAMPLE, Date.parse('2026-09-13T23:00:00Z'));
  assert.equal(parsed?.limits[0].expired, true);
  assert.equal(parsed?.limits[1].expired, false);
});

test('ответ без окон — не данные', () => {
  assert.equal(parseOfficialUsage({ error: 'unauthorized' }, Date.now()), null);
  assert.equal(parseOfficialUsage({ limits: [] }, Date.now()), null);
  assert.equal(parseOfficialUsage(null, Date.now()), null);
});
