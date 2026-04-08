/**
 * Output Coalescer — debounces high-frequency output into frame-sized batches.
 *
 * TUI apps like Claude Code render full-screen frames that span many
 * tmux %output lines. Node.js may deliver these across multiple I/O
 * ticks, so setImmediate coalescing only captures one tick's worth.
 * This module uses a dual-timer debounce:
 *
 *   - idle timer (2 ms): resets on every push. Fires when output
 *     briefly stops, so a completed frame flushes as soon as it's done.
 *   - cap timer  (16 ms): set once per batch, never reset. Guarantees
 *     that continuous streams (e.g. `yes` or a long compile log) still
 *     flush at ~60fps instead of starving clients.
 *
 * Callers invoke `push(key, data)` each time new bytes arrive. The
 * bytes are concatenated into a per-key batch. When either timer
 * fires (or `flush(key)` is called explicitly), `onFlush(key, data)`
 * is invoked exactly once with the concatenated bytes.
 *
 * Raptor 3: the coalescer used to take a `fromSeq` cursor and expect
 * the caller to re-pull bytes from a RingBuffer on flush. That path
 * existed to support client-side replay. Raptor 3 deletes replay, so
 * the coalescer now holds the bytes directly — one fewer layer, one
 * fewer place for a dim mismatch to corrupt a replayed stream.
 *
 * The coalescer has no knowledge of sessions, bridges, or terminal
 * semantics. It is a scheduler that owns timers and keys.
 */

/**
 * @param {object} opts
 * @param {(key: string, data: string) => void} opts.onFlush
 *   Called when a batch flushes. Receives the key and the concatenated
 *   bytes. Must be synchronous from the coalescer's perspective —
 *   async work inside onFlush is fine but the coalescer considers
 *   the batch done the moment this function returns.
 * @param {number} [opts.idleMs=2]
 *   Idle debounce window. Resets on every push.
 * @param {number} [opts.capMs=16]
 *   Hard cap from the first push in a batch. Ensures continuous
 *   streams still flush at roughly one 60fps frame.
 */
export function createOutputCoalescer({ onFlush, idleMs = 2, capMs = 16 }) {
  if (typeof onFlush !== "function") {
    throw new TypeError("createOutputCoalescer: onFlush must be a function");
  }

  /** @type {Map<string, { chunks: string[], idle: NodeJS.Timeout, cap: NodeJS.Timeout }>} */
  const pending = new Map();

  /**
   * Append `data` to the pending batch for `key`. If no batch is pending,
   * start a new one anchored by the idle and cap timers.
   */
  function push(key, data) {
    const existing = pending.get(key);
    if (existing) {
      existing.chunks.push(data);
      // More output arriving — push the idle deadline forward.
      // The cap timer is NOT reset so continuous streams still flush.
      clearTimeout(existing.idle);
      existing.idle = setTimeout(() => flush(key), idleMs);
      return;
    }
    pending.set(key, {
      chunks: [data],
      idle: setTimeout(() => flush(key), idleMs),
      cap: setTimeout(() => flush(key), capMs),
    });
  }

  /**
   * Flush the pending batch for `key` immediately. Safe to call when
   * no batch is pending (no-op). Callers use this before serializing a
   * snapshot so the snapshot captures every byte that's already been
   * relayed to clients at the old dims.
   */
  function flush(key) {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.idle);
    clearTimeout(entry.cap);
    pending.delete(key);
    onFlush(key, entry.chunks.join(""));
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

  return { push, flush, cancel, shutdown };
}
