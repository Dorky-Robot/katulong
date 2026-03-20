/**
 * Session Manager
 *
 * Manages terminal sessions backed by tmux. Extracted from daemon.js to run
 * directly inside server.js — no separate daemon process or IPC needed.
 *
 * tmux provides session persistence, multiplexing, and lifecycle management.
 * This module wraps tmux with a Session class (control mode I/O) and provides
 * the API for session CRUD, client attach/detach, and terminal I/O.
 *
 * Client tracking (multi-client resize arbitration, active-client election)
 * is delegated to the ClientTracker module.
 */

import { execFile } from "node:child_process";
import { log } from "./log.js";
import { getSafeEnv } from "./env-filter.js";
import { createClientTracker } from "./client-tracker.js";
import { Session } from "./session.js";
import {
  tmuxSessionName, tmuxExec, tmuxNewSession, tmuxHasSession,
  applyTmuxSessionOptions, captureScrollback, captureVisiblePane, checkTmux,
  cleanTmuxServerEnv, setTmuxKatulongEnv, tmuxListSessions, tmuxKillSession, tmuxListSessionsDetailed,
} from "./tmux.js";

const MAX_BUFFER = 5000;
const MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_SESSIONS = 20;
const CHILD_COUNT_INTERVAL_MS = 5000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

/**
 * Create a session manager.
 *
 * @param {object} opts
 * @param {object} opts.bridge - Transport bridge for relaying events
 * @param {string} opts.shell - Shell binary path
 * @param {string} opts.home - Home directory (initial cwd for sessions)
 * @returns {object} Session manager API
 */
export function createSessionManager({ bridge, shell, home }) {
  const sessions = new Map();
  const pendingOps = new Map(); // tmuxName -> Promise<Session> (serializes concurrent spawns)
  const detachedNames = new Set(); // tmux names of sessions detached from katulong

  // Output coalescing: batch per-session output within a single I/O cycle
  // using setImmediate (zero artificial delay).  All %output lines from the
  // same tmux data event are processed synchronously in _parseLineBuf, so
  // they accumulate here and flush in the check phase — before the next I/O
  // cycle.  The client's seq-buffer handles ordering; RAF batching coalesces
  // writes within a frame.  No timers needed.
  const outputCoalesce = new Map();  // sessionName -> { data, seq, flush }

  function flushOutputBuffer(sessionName) {
    const state = outputCoalesce.get(sessionName);
    if (!state) return;
    outputCoalesce.delete(sessionName);
    if (state.flush) clearImmediate(state.flush);
    if (state.data) bridge.relay({ type: "output", session: sessionName, data: state.data, seq: state.seq });
  }

  // Client tracker handles multi-client multiplexing and resize arbitration
  const tracker = createClientTracker({
    bridge,
    getSession: (name) => sessions.get(name),
  });

  // --- Child process counting ---

  function countTmuxPaneProcesses(tmuxName) {
    return new Promise((resolve) => {
      execFile("tmux", ["list-panes", "-t", tmuxName, "-F", "#{pane_pid}"], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve(0);
        const panePid = stdout.trim().split("\n")[0];
        if (!/^\d+$/.test(panePid)) return resolve(0);
        execFile("pgrep", ["-P", panePid], (err2, stdout2) => {
          if (err2 || !stdout2.trim()) return resolve(0);
          const children = stdout2.trim().split("\n").filter(p => /^\d+$/.test(p));
          resolve(children.length);
        });
      });
    });
  }

  function aliveSessionCount() {
    let count = 0;
    for (const s of sessions.values()) {
      if (s.alive) count++;
    }
    return count;
  }

  const childCountTimer = setInterval(async () => {
    for (const [name, session] of [...sessions]) {
      if (!session.alive) {
        // Reap dead sessions that have no attached clients
        if (!tracker.hasClients(name)) {
          sessions.delete(name);
          log.info("Reaped dead session", { session: name });
        }
        continue;
      }
      const count = await countTmuxPaneProcesses(session.tmuxName);
      session.updateChildCount(count);
      bridge.relay({ type: "child-count-update", session: name, count });
    }
  }, CHILD_COUNT_INTERVAL_MS);
  childCountTimer.unref();

  // --- Shared helper: adopt an existing tmux session ---

  async function adoptSession(name, tmuxName, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, { external = false } = {}) {
    await applyTmuxSessionOptions(tmuxName);

    const session = new Session(name, tmuxName, {
      maxBufferItems: MAX_BUFFER,
      maxBufferBytes: MAX_BUFFER_BYTES,
      external,
      onData: (sessionName, data) => {
        const existing = outputCoalesce.get(sessionName);
        if (existing) {
          existing.data += data;
        } else {
          const session = sessions.get(sessionName);
          if (!session) return; // session already removed
          // totalBytes already includes this data (push precedes onData callback),
          // so the offset of the start of this chunk is totalBytes - data.length
          outputCoalesce.set(sessionName, {
            data,
            seq: session.outputBuffer.totalBytes - data.length,
            flush: setImmediate(() => flushOutputBuffer(sessionName)),
          });
        }
      },
      onExit: (sessionName, exitCode) => {
        log.info("Session exited", { session: sessionName, exitCode });
        bridge.relay({ type: "exit", session: sessionName, code: exitCode });
      },
    });

    session.attachControlMode(cols, rows);

    // Note: we intentionally do NOT push captureScrollback output into the
    // RingBuffer here.  The RingBuffer must contain only raw %output escape
    // sequences so that catchup data is always a valid terminal byte stream.
    // Mixing rendered capture-pane snapshots with raw %output corrupts
    // catchup slices (rendered text uses different escape sequences than the
    // original stream, causing garbled display when replayed).
    //
    // Each client gets a fresh captureScrollback on attach — the RingBuffer
    // is only used for sequenced catchup between seq-init and live output.

    return session;
  }

  // --- Session helpers ---

  function isAlreadyManaged(tmuxName) {
    if (sessions.has(tmuxName)) return true;
    for (const s of sessions.values()) {
      if (s.tmuxName === tmuxName) return true;
    }
    return false;
  }

  // --- Session operations ---

  async function spawnSession(name, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, cwd = null) {
    // Serialize on tmux name (canonical form) so that spawn("foo bar") and
    // adopt("foo_bar") cannot race — both map to the same tmux session.
    const key = tmuxSessionName(name);
    const pending = pendingOps.get(key);
    if (pending) return pending;

    const promise = doSpawnSession(name, cols, rows, cwd).finally(() => {
      pendingOps.delete(key);
    });
    pendingOps.set(key, promise);
    return promise;
  }

  async function doSpawnSession(name, cols, rows, cwd) {
    const tmuxName = tmuxSessionName(name);

    // Evict any discovered session that maps to the same tmux name
    // (e.g., discovered "foo_bar" vs user creating "foo.bar" → both map to tmux "foo_bar")
    for (const [key, s] of sessions) {
      if (s.tmuxName === tmuxName && key !== name) {
        s.detach();
        sessions.delete(key);
        break;
      }
    }

    const exists = await tmuxHasSession(tmuxName);

    if (!exists) {
      const safeEnv = getSafeEnv();
      const env = {
        ...safeEnv,
        TERM: "xterm-256color",
        TERM_PROGRAM: "katulong",
        COLORTERM: "truecolor",
      };
      await tmuxNewSession(tmuxName, cols, rows, shell, env, cwd || home);
    }

    const session = await adoptSession(name, tmuxName, cols, rows);

    sessions.set(name, session);
    detachedNames.delete(tmuxName);
    log.info("Session created", { session: name, tmux: tmuxName, reattached: exists });
    return session;
  }

  async function doAdoptTmuxSession(tmuxName, cols, rows) {
    const exists = await tmuxHasSession(tmuxName);
    if (!exists) return { error: "tmux session not found" };

    let session;
    try {
      session = await adoptSession(tmuxName, tmuxName, cols, rows, { external: true });
    } catch (err) {
      log.warn("Failed to adopt tmux session", { tmuxName, error: err.message });
      return { error: "Failed to adopt session" };
    }

    // Re-check after async work (guards against races with spawnSession)
    if (isAlreadyManaged(tmuxName)) {
      session.detach();
      return { error: "Session already managed" };
    }

    sessions.set(tmuxName, session);
    detachedNames.delete(tmuxName);
    log.info("Adopted tmux session", { tmuxName });
    return { name: tmuxName };
  }

  // --- Public API ---

  return {
    /**
     * List all sessions.
     * @returns {{ sessions: object[] }}
     */
    listSessions() {
      return { sessions: [...sessions.values()].map(s => s.toJSON()) };
    },

    /**
     * List tmux sessions not currently managed by katulong.
     * @returns {Promise<{ sessions: string[] }>}
     */
    async listTmuxSessions() {
      const tmuxSessions = await tmuxListSessions();
      // Include detached sessions that tmux list-sessions may not yet report
      // (tmux can lag in showing sessions after control mode detach)
      const all = new Set(tmuxSessions);
      for (const name of detachedNames) all.add(name);
      const unmanaged = [...all].filter(name => !isAlreadyManaged(name));

      // Check which sessions have external (non-control-mode) clients attached
      const externalSessions = await tmuxListSessionsDetailed();

      return {
        sessions: unmanaged.map(name => ({
          name,
          attached: externalSessions.has(name),
        })),
      };
    },

    /**
     * Kill an unmanaged tmux session.
     * Refuses to kill sessions that are managed by katulong.
     * @param {string} tmuxName
     * @returns {Promise<{ ok: boolean } | { error: string }>}
     */
    async killTmuxSession(tmuxName) {
      if (!tmuxName || typeof tmuxName !== "string") return { error: "Invalid tmux session name" };
      if (tmuxName.length > 128 || !/^[A-Za-z0-9_\-]+$/.test(tmuxName)) return { error: "Invalid tmux session name" };
      if (isAlreadyManaged(tmuxName)) return { error: "Cannot kill managed session — use DELETE /sessions/:name instead" };
      try {
        await tmuxKillSession(tmuxName);
        detachedNames.delete(tmuxName);
        log.info("Killed unmanaged tmux session", { session: tmuxName });
        return { ok: true };
      } catch (err) {
        log.warn("tmuxKillSession failed", { tmuxName, error: err.message });
        return { error: "Failed to kill tmux session" };
      }
    },

    /**
     * Adopt an existing tmux session into katulong.
     * @param {string} tmuxName
     * @param {number} [cols=120]
     * @param {number} [rows=40]
     * @returns {Promise<{ name: string } | { error: string }>}
     */
    async adoptTmuxSession(tmuxName, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
      if (aliveSessionCount() >= MAX_SESSIONS) return { error: `Maximum session limit (${MAX_SESSIONS}) reached` };
      if (isAlreadyManaged(tmuxName)) return { error: "Session already managed" };

      // Validate name: allowlist safe characters only
      if (tmuxName.length > 128 || !/^[A-Za-z0-9_\-]+$/.test(tmuxName)) {
        return { error: "Invalid tmux session name" };
      }

      // Serialize concurrent adopt calls for the same tmux session
      const pending = pendingOps.get(tmuxName);
      if (pending) {
        await pending;
        return isAlreadyManaged(tmuxName)
          ? { error: "Session already managed" }
          : { error: "Concurrent adopt failed" };
      }

      const promise = doAdoptTmuxSession(tmuxName, cols, rows).finally(() => {
        pendingOps.delete(tmuxName);
      });
      pendingOps.set(tmuxName, promise);
      return promise;
    },

    /**
     * Create a new session.
     * @param {string} name
     * @param {number} [cols=120]
     * @param {number} [rows=40]
     * @param {string} [copyFrom] - Copy cwd from this session
     * @returns {Promise<{ name: string } | { error: string }>}
     */
    async createSession(name, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, copyFrom = null) {
      if (aliveSessionCount() >= MAX_SESSIONS) return { error: `Maximum session limit (${MAX_SESSIONS}) reached` };
      if (sessions.has(name)) return { error: "Session already exists" };

      // Check for tmux name collision (e.g. "my session" vs "my_session" both map to "my_session")
      const newTmuxName = tmuxSessionName(name);
      for (const s of sessions.values()) {
        if (s.tmuxName === newTmuxName) return { error: "Session name conflicts with existing session" };
      }

      let cwd = null;
      if (copyFrom) {
        const source = sessions.get(copyFrom);
        if (source) {
          const result = await new Promise((resolve) => {
            execFile("tmux", ["display-message", "-t", source.tmuxName, "-p", "#{pane_current_path}"],
              { timeout: 5000 }, (err, stdout) => {
                resolve(err ? null : stdout.trim());
              });
          });
          cwd = result;
        }
      }

      await spawnSession(name, cols, rows, cwd);
      return { name };
    },

    /**
     * Delete a session.
     * @param {string} name
     * @param {{ detachOnly?: boolean }} [opts]
     * @returns {{ ok: true, action: string } | { error: string }}
     */
    deleteSession(name, { detachOnly = false } = {}) {
      const session = sessions.get(name);
      if (!session) return { error: "Not found" };
      // Flush any pending coalesced output before removing
      flushOutputBuffer(name);
      const tmuxName = session.tmuxName;
      if (detachOnly) {
        session.detach();
        detachedNames.add(tmuxName);
      } else {
        session.kill();
        detachedNames.delete(tmuxName);
      }
      const action = detachOnly ? "detached" : "deleted";
      sessions.delete(name);
      tracker.detachAll(name);
      bridge.relay({ type: "session-removed", session: name });
      log.info("Session removed", { session: name, action });
      return { ok: true, action };
    },

    /**
     * Rename a session.
     * @param {string} oldName
     * @param {string} newName
     * @returns {{ name: string } | { error: string }}
     */
    async renameSession(oldName, newName) {
      const session = sessions.get(oldName);
      if (!session || sessions.has(newName)) return { error: "Not found or name taken" };

      // Flush pending coalesced output under the old name before renaming,
      // so it's relayed with the correct session name (same pattern as
      // deleteSession and attachClient).
      flushOutputBuffer(oldName);

      const newTmuxName = tmuxSessionName(newName);
      for (const s of sessions.values()) {
        if (s.tmuxName === newTmuxName && s !== session) return { error: "Session name conflicts with existing session" };
      }
      if (newTmuxName !== session.tmuxName) {
        const tmuxExists = await tmuxHasSession(newTmuxName);
        if (tmuxExists) return { error: "Session name conflicts with existing tmux session" };
      }
      const { code } = await tmuxExec(["rename-session", "-t", session.tmuxName, newTmuxName]);
      if (code !== 0) return { error: "Failed to rename tmux session" };

      session.name = newName;
      session.tmuxName = newTmuxName;
      sessions.delete(oldName);
      sessions.set(newName, session);
      tracker.renameSession(oldName, newName);
      bridge.relay({ type: "session-renamed", session: oldName, newName });
      log.info("Session renamed", { from: oldName, to: newName });
      return { name: newName };
    },

    /**
     * Attach a client to a session (creates if needed).
     * @param {string} clientId
     * @param {string} sessionName
     * @param {number} cols
     * @param {number} rows
     * @returns {Promise<{ buffer: string, alive: boolean }>}
     */
    async attachClient(clientId, sessionName, cols, rows) {
      if (!sessionName) throw new Error("Session name required");
      const name = sessionName;

      let session = sessions.get(name);
      if (!session) {
        const newTmuxName = tmuxSessionName(name);
        for (const s of sessions.values()) {
          if (s.tmuxName === newTmuxName) {
            throw new Error("Session name conflicts with existing session");
          }
        }
        session = await spawnSession(name, cols, rows);
      }

      // Delegate to tracker (handles idempotency, active-client election, resize)
      tracker.attach(clientId, name, cols, rows);

      let buffer = "";
      // Flush pending coalesced output before the async capture window
      // so other clients get the data and totalBytes is up-to-date.
      flushOutputBuffer(name);
      if (session.alive) {
        // Send scrollback (not just visible pane) so the client can scroll
        // up through history from before the WebSocket connection started.
        // captureScrollback uses -p -e (pre-rendered ANSI text), safe to replay.
        // Falls back to visible pane if scrollback capture fails.
        const snapshot = await captureScrollback(session.tmuxName)
          || await captureVisiblePane(session.tmuxName);
        if (snapshot) buffer = snapshot;

        // Resize to the client's dimensions. The dedup guard in
        // session.resize() skips if dimensions match — this is correct:
        // if dimensions haven't changed, the snapshot is already accurate
        // and a SIGWINCH would cause a redundant TUI redraw that races
        // with the snapshot, producing duplicated content.
        session.resize(cols, rows);
      }
      // Snapshot totalBytes AFTER captureScrollback completes. Any output
      // that arrived during the async capture is visually included in the
      // scrollback snapshot and already pushed to the RingBuffer.  By
      // taking the seq here, seq-init tells the client to expect output
      // AFTER the captured state, preventing the catchup mechanism from
      // replaying data the scrollback already contains (which caused
      // duplicate writes and garbled text).
      flushOutputBuffer(name);
      const seq = session.outputBuffer.totalBytes;
      return { buffer, alive: session.alive, seq };
    },

    /**
     * Get the session name a client is attached to.
     * @param {string} clientId
     * @returns {string|null}
     */
    getSessionForClient(clientId) {
      return tracker.getSessionFor(clientId);
    },

    /**
     * Detach a client from its session.
     * @param {string} clientId
     */
    detachClient(clientId) {
      tracker.detach(clientId);
    },

    /**
     * Write input to a client's session.
     * @param {string} clientId
     * @param {string} data
     * @param {string} [explicitSession] - Preferred session name from message; falls back to tracker
     */
    writeInput(clientId, data, explicitSession) {
      try {
        tracker.markActive(clientId);
        const sessionName = explicitSession || tracker.getSessionFor(clientId);
        if (sessionName) {
          const session = sessions.get(sessionName);
          if (session?.alive) session.write(data);
        }
      } catch (err) {
        log.warn("writeInput failed", { clientId, error: err.message });
      }
    },

    /**
     * Resize a client's session.
     * @param {string} clientId
     * @param {number} cols
     * @param {number} rows
     */
    resizeClient(clientId, cols, rows) {
      tracker.resize(clientId, cols, rows);
    },

    /**
     * Get a session by name.
     * @param {string} name
     * @returns {Session|undefined}
     */
    getSession(name) {
      return sessions.get(name);
    },

    /**
     * Shutdown: close control mode processes but leave tmux sessions alive.
     */
    shutdown() {
      clearInterval(childCountTimer);
      for (const state of outputCoalesce.values()) {
        if (state.flush) clearImmediate(state.flush);
      }
      outputCoalesce.clear();
      for (const [, session] of sessions) {
        session.detach();
      }
    },
  };
}

export { checkTmux, cleanTmuxServerEnv, setTmuxKatulongEnv };
