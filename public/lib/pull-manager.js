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

const PULL_TIMEOUT_MS = 2000;
const WRITE_TIMEOUT_MS = 1500;

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
    if (ps.pulling) {
      ps.pending = true;
      return;
    }
    // Allow pull even while writing — cursor is updated immediately on
    // pull-response so overlapping writes + pulls are safe.
    pull(name);
  }

  /** Advance cursor after writing data. Shared by pullResponse/pullSnapshot. */
  function _writeAndAdvance(name, data, cursor) {
    const ps = sessions.get(name);
    if (!ps) return;
    ps.pulling = false;
    ps.cursor = cursor; // Advance cursor immediately so next pull can start
    clearTimeout(pullTimers.get(name));

    if (data && data.length > 0) {
      ps.writing = true;
      // Safety: unstick if write callback never fires
      const safety = setTimeout(() => {
        if (ps.writing) {
          ps.writing = false;
          if (ps.pending) { ps.pending = false; pull(name); }
        }
      }, WRITE_TIMEOUT_MS);

      onWrite(name, data, () => {
        clearTimeout(safety);
        ps.writing = false;
        if (ps.pending) { ps.pending = false; pull(name); }
      });
    } else {
      if (ps.pending) { ps.pending = false; pull(name); }
    }

    // If data-available came in while we were pulling, re-pull now
    if (ps.pending && !ps.pulling) { ps.pending = false; pull(name); }
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
