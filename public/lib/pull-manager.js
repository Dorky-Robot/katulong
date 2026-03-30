/**
 * Pull Manager
 *
 * Pure state machine for pull-based terminal output streaming.
 * Manages per-session cursors, pull/write coordination, and safety timeouts.
 *
 * No knowledge of WebSockets, xterm, or DOM. Communicates via callbacks:
 *   - onSendPull(session, fromSeq)  — request data from server
 *   - onWrite(session, data, done)  — write data to terminal, call done() when finished
 *   - onReset(session)              — clear terminal before snapshot
 *
 * State per session: { cursor, pulling, writing, pending }
 *   - pulling: waiting for server response
 *   - writing: xterm is processing a write
 *   - pending: data-available arrived while busy — will re-pull after current op
 */

const PULL_TIMEOUT_MS = 1000;
const WRITE_TIMEOUT_MS = 500;

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
    } else {
      sessions.set(name, { cursor, pulling: false, writing: false, pending: false });
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
      const safety = setTimeout(() => {
        if (ps.writing) {
          ps.writing = false;
          // Safety timeout: advance cursor to avoid infinite re-pull
          ps.cursor = cursor;
          if (ps.pending) { ps.pending = false; pull(name); }
        }
      }, WRITE_TIMEOUT_MS);

      onWrite(name, data, (accepted) => {
        clearTimeout(safety);
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

  return { init, clear, pull, dataAvailable, pullResponse, pullSnapshot, get };
}
