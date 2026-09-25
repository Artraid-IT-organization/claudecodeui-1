import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import TokenUsageSummary from './TokenUsageSummary';

const text = (usage: Record<string, unknown> | null) =>
  renderToStaticMarkup(<TokenUsageSummary usage={usage} />).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('shows the context share against a 1M window without a trailing .0', () => {
  assert.equal(text({ used: 691929, total: 1000000 }), '69% 692K/1M');
});

test('keeps one decimal for fractional millions', () => {
  assert.equal(text({ used: 1500000, total: 2000000 }), '75% 1.5M/2M');
});

test('shows the share against a 200K window', () => {
  assert.equal(text({ used: 30111, total: 200000 }), '15% 30K/200K');
});

test('falls back to the plain token count when the window is unknown', () => {
  assert.equal(text({ used: 691929 }), '692K токенов');
});
