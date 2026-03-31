/**
 * Pull Manager
 *
 * Pure state machine for terminal output streaming.  The server pushes data
 * inline (outputReceived) for zero-round-trip delivery; pull is the fallback
 * for cursor mismatches, reconnection, and cursor eviction recovery.
 *
 * No knowledge of WebSockets, xterm, or DOM. Communicates via callbacks:
 *   - onSendPull(session, fromSeq)  — request data from server
 *   - onWrite(session, data, done)  — write data to terminal, call done() when finished
 *   - onReset(session)              — clear terminal before snapshot
 *
 * State per session: { cursor, pulling, writing, pending }
 *   - pulling: waiting for server response
 *   - writing: xterm is processing a write
 *   - pending: data arrived while busy — will re-pull after current op
 */

const PULL_TIMEOUT_MS = 1000;
const WRITE_TIMEOUT_MS = 2000;

export function createPullManager({ onSendPull, onWrite, onReset }) {
  const sessions = new Map(); // sessionName -> { cursor, pulling, writing, pending }
  const pullTimers = new Map();

  function get(name) { return sessions.get(name); }

  function init(name, cursor) {
    const existing = sessions.get(name);
    if (existing) {
      existing.cursor = cursor;
      existing.pulling = false;
      existing.writing = false;
      existing.pending = false;
      existing._writeId = (existing._writeId || 0) + 1; // invalidate stale callbacks
    } else {
      sessions.set(name, { cursor, pulling: false, writing: false, pending: false, _writeId: 0 });
    }
    pull(name);
  }

  function clear(name) {
    if (name) {
      sessions.delete(name);
      clearTimeout(pullTimers.get(name));
      pullTimers.delete(name);
    } else {
      sessions.clear();
      for (const t of pullTimers.values()) clearTimeout(t);
      pullTimers.clear();
    }
  }

  function pull(name) {
    const ps = sessions.get(name);
    if (!ps || ps.pulling) return;
    ps.pulling = true;
    onSendPull(name, ps.cursor);

    // Safety: unstick if server never responds
    clearTimeout(pullTimers.get(name));
    pullTimers.set(name, setTimeout(() => {
      const ps = sessions.get(name);
      if (ps?.pulling) {
        ps.pulling = false;
        pull(name);
      }
    }, PULL_TIMEOUT_MS));
  }

  function dataAvailable(name) {
    const ps = sessions.get(name);
    if (!ps) return;
    if (ps.pulling || ps.writing) {
      // Wait for current operation to complete — pulling with a stale
      // cursor would re-fetch data already being written, causing garble.
      ps.pending = true;
      return;
    }
    pull(name);
  }

  /** Process pull response: write data to terminal, advance cursor. */
  function _writeAndAdvance(name, data, cursor) {
    const ps = sessions.get(name);
    if (!ps) return;
    ps.pulling = false;
    clearTimeout(pullTimers.get(name));

    if (data && data.length > 0) {
      ps.writing = true;
      // Generation counter: prevents stale write callbacks from resetting
      // cursor state.  When the safety timeout fires (slow xterm render on
      // mobile), it advances the cursor and triggers a new pull.  Without
      // this guard, the LATE original callback would reset the cursor to
      // the old position, causing a re-pull of already-rendered data —
      // producing garbled text and duplicate entries.
      const writeId = ++ps._writeId;

      const safety = setTimeout(() => {
        if (ps._writeId !== writeId) return; // superseded by newer write
        if (ps.writing) {
          ps.writing = false;
          ps.cursor = cursor;
          if (ps.pending) { ps.pending = false; pull(name); }
        }
      }, WRITE_TIMEOUT_MS);

      onWrite(name, data, (accepted) => {
        clearTimeout(safety);
        // If a newer write has started (safety timeout triggered a pull
        // whose response already arrived), this callback is stale.
        if (ps._writeId !== writeId) return;
        ps.writing = false;
        if (accepted === false) {
          // Write rejected (no terminal) — don't advance cursor.
          // Retry after a short delay.
          ps.pending = true;
          setTimeout(() => {
            if (ps.pending) { ps.pending = false; pull(name); }
          }, 100);
          return;
        }
        // Advance cursor AFTER successful write — this is the natural
        // backpressure mechanism: the next pull waits until xterm finishes
        // rendering, preventing data overlap and garble.
        ps.cursor = cursor;
        if (ps.pending) { ps.pending = false; pull(name); }
      });
    } else {
      ps.cursor = cursor;
      if (ps.pending) { ps.pending = false; pull(name); }
    }
  }

  function pullResponse(name, data, cursor) {
    _writeAndAdvance(name, data, cursor);
  }

  function pullSnapshot(name, data, cursor) {
    onReset(name);
    _writeAndAdvance(name, data || "", cursor);
  }

  /** Accept server-pushed output directly (zero round trips). */
  function outputReceived(name, data, cursor, fromSeq) {
    const ps = sessions.get(name);
    if (!ps) return;
    if (ps.pulling || ps.writing) {
      ps.pending = true; // will re-pull when current op finishes
      return;
    }
    if (fromSeq !== ps.cursor) {
      pull(name); // gap detected — fall back to pull
      return;
    }
    _writeAndAdvance(name, data, cursor);
  }

  return { init, clear, pull, dataAvailable, pullResponse, pullSnapshot, outputReceived, get };
}
