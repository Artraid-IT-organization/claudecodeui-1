import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageLimitsView } from './UsageLimitsView';

const t = (_key: string, options: { defaultValue: string; time?: string }) =>
  options.defaultValue.replace('{{time}}', options.time ?? '');

const inHours = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

test('показывает пятичасовое и недельное окна с процентами и сроком сброса', () => {
  const html = renderToStaticMarkup(
    React.createElement(UsageLimitsView, {
      fetchedAtMs: Date.now(),
      t,
      rows: [
        { kind: 'session', percent: 14, severity: 'normal', resetsAt: inHours(4), modelName: null, expired: false },
        { kind: 'weekly_all', percent: 43, severity: 'warning', resetsAt: inHours(48), modelName: null, expired: false },
      ],
    }),
  );
  assert.match(html, /5 часов/);
  assert.match(html, />14%</);
  assert.match(html, />4 ч</);
  assert.match(html, /Неделя/);
  assert.match(html, />43%</);
  assert.match(html, />2 дн</);
  assert.match(html, /bg-amber-500/);
  assert.doesNotMatch(html, /данные не свежие/);
});

test('подписывает несвежие данные', () => {
  const html = renderToStaticMarkup(
    React.createElement(UsageLimitsView, {
      fetchedAtMs: Date.now() - 4 * 3600_000,
      t,
      rows: [
        { kind: 'session', percent: 5, severity: 'normal', resetsAt: inHours(1), modelName: null, expired: false },
      ],
    }),
  );
  assert.match(html, /данные не свежие/);
});
