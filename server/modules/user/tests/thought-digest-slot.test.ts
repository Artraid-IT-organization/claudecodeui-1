import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withDigestSlot } from '@/modules/user/thought-translation.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('одновременно идут не больше двух вызовов, лишние сверх очереди отбрасываются', async () => {
  let now = 0;
  let peak = 0;
  const job = async () => {
    now += 1;
    peak = Math.max(peak, now);
    await sleep(30);
    now -= 1;
    return 'ok';
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => withDigestSlot(job)));
  assert.equal(peak, 2);
  assert.equal(results.filter((r) => r === 'ok').length, 8); // 2 сразу + 6 в очереди
  assert.equal(results.filter((r) => r === null).length, 12);
});

test('после разгрузки очередь снова принимает вызовы, счётчик не течёт', async () => {
  for (let round = 0; round < 3; round += 1) {
    const results = await Promise.all(Array.from({ length: 8 }, () => withDigestSlot(async () => {
      await sleep(5);
      return round;
    })));
    assert.equal(results.filter((r) => r === round).length, 8);
  }
});

test('упавший вызов тоже освобождает место', async () => {
  await assert.rejects(withDigestSlot(async () => { throw new Error('boom'); }));
  await assert.rejects(withDigestSlot(async () => { throw new Error('boom'); }));
  assert.equal(await withDigestSlot(async () => 'после сбоя'), 'после сбоя');
});
