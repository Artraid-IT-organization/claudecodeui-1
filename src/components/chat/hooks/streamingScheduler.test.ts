import test from 'node:test';
import assert from 'node:assert/strict';

let animationFrameQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextAnimationFrameId = 1;

globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  const id = nextAnimationFrameId++;
  animationFrameQueue.push({ id, cb });
  return id;
};

globalThis.cancelAnimationFrame = (id: number): void => {
  animationFrameQueue = animationFrameQueue.filter((entry) => entry.id !== id);
};

function runAnimationFrames() {
  const queue = animationFrameQueue;
  animationFrameQueue = [];
  for (const entry of queue) {
    entry.cb(performance.now());
  }
}

const { createStreamingScheduler } = await import('./streamingScheduler');

test('coalesces multiple deltas into one flush per animation frame', () => {
  const flushed: Array<{ id: string; text: string }> = [];
  const scheduler = createStreamingScheduler((id, text) => {
    flushed.push({ id, text });
  });

  scheduler.schedule('s1', 'a');
  scheduler.schedule('s1', 'b');
  scheduler.schedule('s1', 'c');

  assert.strictEqual(flushed.length, 0, 'no flush before animation frame');

  runAnimationFrames();

  assert.strictEqual(flushed.length, 1);
  assert.strictEqual(flushed[0].text, 'abc');
  assert.strictEqual(animationFrameQueue.length, 0, 'frame was consumed');
});

test('schedules a new frame after the previous one fires', () => {
  const flushed: string[] = [];
  const scheduler = createStreamingScheduler((_, text) => {
    flushed.push(text);
  });

  scheduler.schedule('s1', 'a');
  runAnimationFrames();
  scheduler.schedule('s1', 'b');
  runAnimationFrames();

  assert.deepStrictEqual(flushed, ['a', 'ab']);
});

test('flush forces immediate update and cancels pending frame', () => {
  const flushed: string[] = [];
  const scheduler = createStreamingScheduler((_, text) => {
    flushed.push(text);
  });

  scheduler.schedule('s1', 'x');
  scheduler.flush('s1');

  assert.deepStrictEqual(flushed, ['x']);
  assert.strictEqual(animationFrameQueue.length, 0);
});

test('drop clears the accumulated text so a closed block cannot leak into the next', () => {
  const flushed: string[] = [];
  const scheduler = createStreamingScheduler((_, text) => {
    flushed.push(text);
  });

  // Первый блок: дельты → кадр → граница (stream_end) делает flush + drop.
  scheduler.schedule('s1', 'Первый блок. ');
  scheduler.flush('s1');
  scheduler.drop('s1');

  // Второй блок — только его текст, без хвоста первого. Раньше буфер
  // переживал границу, и каждая финализация печатала нарастающую копию.
  scheduler.schedule('s1', 'Второй блок.');
  scheduler.flush('s1');
  scheduler.drop('s1');

  assert.deepStrictEqual(flushed, ['Первый блок. ', 'Второй блок.']);
});

test('drop cancels a pending frame without flushing', () => {
  const flushed: string[] = [];
  const scheduler = createStreamingScheduler((_, text) => {
    flushed.push(text);
  });

  scheduler.schedule('s1', 'x');
  scheduler.drop('s1');
  runAnimationFrames();

  assert.deepStrictEqual(flushed, []);
  assert.strictEqual(animationFrameQueue.length, 0);
});

test('reset cancels pending frames and drops accumulated text', () => {
  const flushed: string[] = [];
  const scheduler = createStreamingScheduler((_, text) => {
    flushed.push(text);
  });

  scheduler.schedule('s1', 'x');
  scheduler.reset();
  runAnimationFrames();

  assert.deepStrictEqual(flushed, []);
});

test('different sessions flush independently', () => {
  const flushed: Array<{ id: string; text: string }> = [];
  const scheduler = createStreamingScheduler((id, text) => {
    flushed.push({ id, text });
  });

  scheduler.schedule('s1', 'a');
  scheduler.schedule('s2', 'b');
  runAnimationFrames();

  assert.strictEqual(flushed.length, 2);
  assert.ok(flushed.some((f) => f.id === 's1' && f.text === 'a'));
  assert.ok(flushed.some((f) => f.id === 's2' && f.text === 'b'));
});

test('flush without accumulated text does not call onFlush', () => {
  let called = false;
  const scheduler = createStreamingScheduler(() => {
    called = true;
  });

  scheduler.flush('s1');
  assert.strictEqual(called, false);
});
