import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDevinAccountUsage } from '../services/devin-account-limits.service.js';

// Урезанный настоящий ответ GetUserStatus, снят 03.10.26 (аккаунт Devin Pro).
const SAMPLE = {
  userStatus: {
    email: 'devin-user@example.com',
    planStatus: {
      planInfo: {
        planName: 'Pro',
        devinInfo: { canUseCascade: true, canUseCli: true },
      },
      dailyQuotaRemainingPercent: 100,
      weeklyQuotaRemainingPercent: 81,
      dailyQuotaResetAtUnix: '1791100800',
      weeklyQuotaResetAtUnix: '1791100800',
    },
  },
};

test('остаток квоты переводится в израсходованный процент, сброс — в ISO', () => {
  const now = Date.parse('2026-10-03T15:00:00Z');
  const parsed = parseDevinAccountUsage(SAMPLE, now);
  assert.equal(parsed.available, true);
  assert.equal(parsed.email, 'devin-user@example.com');
  assert.equal(parsed.planName, 'Pro');
  assert.deepEqual(
    parsed.limits.map((limit) => [limit.kind, limit.percent, limit.expired]),
    [['daily', 0, false], ['weekly', 19, false]],
  );
  assert.equal(parsed.limits[0].resetsAt, '2026-10-04T08:00:00.000Z');
});

test('скрытые тарифом окна не показываются', () => {
  const hidden = {
    userStatus: {
      planStatus: {
        ...SAMPLE.userStatus.planStatus,
        planInfo: { planName: 'Pro', devinInfo: { hideWeeklyQuota: true } },
      },
    },
  };
  const parsed = parseDevinAccountUsage(hidden, Date.parse('2026-10-03T15:00:00Z'));
  assert.deepEqual(parsed.limits.map((limit) => limit.kind), ['daily']);
});

test('окно, время сброса которого прошло, помечается expired', () => {
  const parsed = parseDevinAccountUsage(SAMPLE, Date.parse('2026-10-04T09:00:00Z'));
  assert.equal(parsed.limits[0].expired, true);
});

test('ответ без userStatus или без planStatus — недоступно', () => {
  assert.equal(parseDevinAccountUsage({ error: 'unauthorized' }, Date.now()).available, false);
  assert.equal(parseDevinAccountUsage({ userStatus: { email: 'a@b.c' } }, Date.now()).available, false);
  assert.equal(parseDevinAccountUsage(null, Date.now()).available, false);
});
