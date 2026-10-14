/**
 * Coalesces a stream of small text deltas into one store update per animation
 * frame. Used for both live assistant text (`stream_delta`) and live thinking
 * (`thinking_delta`).
 *
 * Why not a fixed 100 ms timer? When the model emits deltas quickly, a fixed
 * timer adds an unnecessary wait; when rendering is slow, a fixed timer lets
 * deltas pile up and then dumps them as a visible stutter. Coalescing to the
 * next paint frame keeps updates aligned with what the screen can actually
 * show and naturally throttles to one update per frame.
 *
 * Terminal events must still call `flush()` to force out any deltas that arrived
 * after the last frame but before the stream closed.
 */

export type StreamingScheduler = {
  /** Accumulate `delta` for `id` and schedule a flush on the next frame. */
  schedule(id: string, delta: string): void;
  /** Force-flush accumulated text for `id`, if any. */
  flush(id: string): void;
  /** Cancel any pending frame for `id` without flushing. */
  cancel(id: string): void;
  /**
   * Close the block for `id`: cancel its pending frame AND drop the
   * accumulated text. Required at every block boundary (`stream_end`,
   * `complete`): `accumulated` holds the block's whole text, and leaving it
   * behind makes the NEXT block start from the old content — every later
   * finalize then prints a longer copy of the same message (the growing
   * duplicate bubbles seen 14.10.26).
   */
  drop(id: string): void;
  /** Read the accumulated text for `id` without flushing. */
  read(id: string): string | undefined;
  /** Cancel all pending frames and drop all accumulated text. */
  reset(): void;
};

export function createStreamingScheduler(
  onFlush: (id: string, text: string) => void,
): StreamingScheduler {
  const accumulated = new Map<string, string>();
  const scheduled = new Map<string, number>();

  function doFlush(id: string): void {
    scheduled.delete(id);
    const text = accumulated.get(id);
    if (text !== undefined) {
      onFlush(id, text);
    }
  }

  return {
    schedule(id: string, delta: string): void {
      accumulated.set(id, (accumulated.get(id) ?? '') + delta);
      if (!scheduled.has(id)) {
        scheduled.set(id, requestAnimationFrame(() => doFlush(id)));
      }
    },

    flush(id: string): void {
      const handle = scheduled.get(id);
      if (handle !== undefined) {
        cancelAnimationFrame(handle);
        scheduled.delete(id);
      }
      doFlush(id);
    },

    cancel(id: string): void {
      const handle = scheduled.get(id);
      if (handle !== undefined) {
        cancelAnimationFrame(handle);
        scheduled.delete(id);
      }
    },

    drop(id: string): void {
      const handle = scheduled.get(id);
      if (handle !== undefined) {
        cancelAnimationFrame(handle);
        scheduled.delete(id);
      }
      accumulated.delete(id);
    },

    read(id: string): string | undefined {
      return accumulated.get(id);
    },

    reset(): void {
      for (const handle of scheduled.values()) {
        cancelAnimationFrame(handle);
      }
      scheduled.clear();
      accumulated.clear();
    },
  };
}
