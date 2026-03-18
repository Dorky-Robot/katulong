/**
 * Sequence Buffer
 *
 * Receives (seq, data) pairs from the server and flushes them in order.
 * Buffers out-of-order chunks and triggers catchup on gap timeout.
 */

const MAX_PENDING = 32;
const GAP_TIMEOUT_MS = 2000;

export function createSeqBuffer({ onFlush, onGapTimeout }) {
  let expectedSeq = 0;
  let initialized = false;
  const pending = new Map(); // seq -> data
  let gapTimer = null;

  function clearGapTimer() {
    if (gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
  }

  function startGapTimer() {
    clearGapTimer();
    gapTimer = setTimeout(() => {
      gapTimer = null;
      if (onGapTimeout) onGapTimeout(expectedSeq);
    }, GAP_TIMEOUT_MS);
  }

  function drainPending() {
    let flushed = false;
    while (pending.has(expectedSeq)) {
      const data = pending.get(expectedSeq);
      pending.delete(expectedSeq);
      expectedSeq += data.length;
      onFlush(data);
      flushed = true;
    }
    if (flushed && pending.size > 0) {
      // Still have buffered items — restart gap timer
      startGapTimer();
    } else if (pending.size === 0) {
      clearGapTimer();
    }
  }

  return {
    /** Set expectedSeq and clear pending buffer. Called on attach/switch. */
    init(seq) {
      expectedSeq = seq;
      initialized = true;
      pending.clear();
      clearGapTimer();
    },

    /**
     * Push a sequenced chunk. Returns true if flushed immediately.
     */
    push(seq, data) {
      if (!initialized) return false;

      if (seq === expectedSeq) {
        // In order — flush immediately
        clearGapTimer();
        expectedSeq += data.length;
        onFlush(data);
        // Drain any consecutive pending
        drainPending();
        return true;
      }

      if (seq < expectedSeq) {
        // Overlapping or duplicate — trim overlap
        const overlap = expectedSeq - seq;
        if (overlap < data.length) {
          // Partial overlap — flush the non-overlapping tail
          const trimmed = data.slice(overlap);
          expectedSeq += trimmed.length;
          onFlush(trimmed);
          drainPending();
        }
        // Else: fully duplicate, discard
        return false;
      }

      // Gap detected — buffer and start timer
      pending.set(seq, data);

      if (pending.size > MAX_PENDING) {
        // Too many pending — trigger catchup instead of buffering more
        clearGapTimer();
        pending.clear();
        if (onGapTimeout) onGapTimeout(expectedSeq);
        return false;
      }

      startGapTimer();
      return false;
    },

    /** Returns current expected byte offset. */
    getExpectedSeq() {
      return expectedSeq;
    },

    /** Whether the buffer has been initialized. */
    isInitialized() {
      return initialized;
    },

    /** Clear pending, cancel timers. */
    clear() {
      pending.clear();
      clearGapTimer();
      initialized = false;
      expectedSeq = 0;
    },
  };
}
