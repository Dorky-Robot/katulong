/**
 * Output Coalescer — debounces high-frequency output notifications into
 * frame-sized batches.
 *
 * TUI apps like Claude Code render full-screen frames that span many
 * tmux %output lines. Node.js may deliver these across multiple I/O
 * ticks, so setImmediate coalescing only captures one tick's worth.
 * This module uses a dual-timer debounce:
 *
 *   - idle timer (2 ms): resets on every notify. Fires when output
 *     briefly stops, so a completed frame flushes as soon as it's done.
 *   - cap timer  (16 ms): set once per batch, never reset. Guarantees
 *     that continuous streams (e.g. `yes` or a long compile log) still
 *     flush at ~60fps instead of starving clients.
 *
 * Callers invoke `notify(key, fromSeq)` each time new bytes arrive.
 * `fromSeq` is captured on the FIRST notify of a batch and held until
 * flush — it marks where the batch started in the byte stream. Once
 * either timer fires (or `flush(key)` is called explicitly), `onFlush`
 * is invoked exactly once with the stored `fromSeq`.
 *
 * The coalescer has no knowledge of sessions, bridges, or terminal
 * semantics. It is a scheduler that owns timers and keys. The `onFlush`
 * callback is responsible for pulling the actual data and relaying it.
 *
 * Extracted from session-manager.js (Tier 3.3) so the timing logic can
 * be tested in isolation and reused if another module ever needs the
 * same debounce shape.
 */

/**
 * @param {object} opts
 * @param {(key: string, fromSeq: number) => void} opts.onFlush
 *   Called when a batch flushes. Receives the key and the captured
 *   fromSeq. Must be synchronous from the coalescer's perspective —
 *   async work inside onFlush is fine but the coalescer considers
 *   the batch done the moment this function returns.
 * @param {number} [opts.idleMs=2]
 *   Idle debounce window. Resets on every notify.
 * @param {number} [opts.capMs=16]
 *   Hard cap from the first notify in a batch. Ensures continuous
 *   streams still flush at roughly one 60fps frame.
 */
export function createOutputCoalescer({ onFlush, idleMs = 2, capMs = 16 }) {
  if (typeof onFlush !== "function") {
    throw new TypeError("createOutputCoalescer: onFlush must be a function");
  }

  /** @type {Map<string, { fromSeq: number, idle: NodeJS.Timeout, cap: NodeJS.Timeout }>} */
  const pending = new Map();

  /**
   * Record that new data is available for `key`. If a batch is already
   * pending, this resets the idle timer; otherwise it starts a new batch
   * anchored at `fromSeq`.
   */
  function notify(key, fromSeq) {
    const existing = pending.get(key);
    if (existing) {
      // More output arriving — push the idle deadline forward.
      // The cap timer is NOT reset so continuous streams still flush.
      clearTimeout(existing.idle);
      existing.idle = setTimeout(() => flush(key), idleMs);
      return;
    }
    pending.set(key, {
      fromSeq,
      idle: setTimeout(() => flush(key), idleMs),
      cap: setTimeout(() => flush(key), capMs),
    });
  }

  /**
   * Flush the pending batch for `key` immediately. Safe to call when
   * no batch is pending (no-op). Callers use this on rename, subscribe,
   * and deleteSession to avoid stranding in-flight bytes.
   */
  function flush(key) {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.idle);
    clearTimeout(entry.cap);
    pending.delete(key);
    onFlush(key, entry.fromSeq);
  }

  /**
   * Drop the pending batch for `key` without calling onFlush. Used on
   * shutdown so pending timers don't keep the event loop alive.
   */
  function cancel(key) {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.idle);
    clearTimeout(entry.cap);
    pending.delete(key);
  }

  /**
   * Cancel every pending batch. Used during shutdown.
   */
  function shutdown() {
    for (const entry of pending.values()) {
      clearTimeout(entry.idle);
      clearTimeout(entry.cap);
    }
    pending.clear();
  }

  return { notify, flush, cancel, shutdown };
}
