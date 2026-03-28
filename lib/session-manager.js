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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import { getSafeEnv } from "./env-filter.js";
import { createClientTracker } from "./client-tracker.js";
import { Session } from "./session.js";
import {
  tmuxSessionName, tmuxExec, tmuxNewSession, tmuxHasSession,
  applyTmuxSessionOptions, captureScrollback, captureVisiblePane, getCursorPosition, checkTmux,
  cleanTmuxServerEnv, setTmuxKatulongEnv, tmuxListSessions, tmuxKillSession, tmuxListSessionsDetailed,
} from "./tmux.js";

const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20 MB per session
const MAX_SESSIONS = 20;
const CHILD_COUNT_INTERVAL_MS = 5000;
// Match client's FIXED_COLS. All terminals use 80 cols to avoid
// horizontal reflow on resize. Rows default to 24 (standard).
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const RESYNC_IDLE_MS = 10000; // 10 seconds of idle before sending resync snapshot

/**
 * Create a session manager.
 *
 * @param {object} opts
 * @param {object} opts.bridge - Transport bridge for relaying events
 * @param {string} opts.shell - Shell binary path
 * @param {string} opts.home - Home directory (initial cwd for sessions)
 * @param {string} [opts.dataDir] - Data directory for persisting session map
 * @returns {object} Session manager API
 */
export function createSessionManager({ bridge, shell, home, dataDir }) {
  const sessions = new Map();
  const pendingOps = new Map(); // tmuxName -> Promise<Session> (serializes concurrent spawns)
  const detachedNames = new Set(); // tmux names of sessions detached from katulong

  // --- Session persistence ---
  const sessionsJsonPath = dataDir ? join(dataDir, "sessions.json") : null;
  let saveTimer = null;

  function serializeSessionMap() {
    const obj = {};
    for (const [name, session] of sessions) {
      obj[name] = session.tmuxName;
    }
    return obj;
  }

  function saveSessionsSync() {
    if (!sessionsJsonPath) return;
    try {
      writeFileSync(sessionsJsonPath, JSON.stringify(serializeSessionMap(), null, 2), "utf-8");
    } catch (err) {
      log.warn("Failed to save sessions.json", { error: err.message });
    }
  }

  function scheduleSave() {
    if (!sessionsJsonPath) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveSessionsSync();
    }, 100);
    if (saveTimer.unref) saveTimer.unref();
  }

  // Multi-session subscriptions: clientId -> Set<sessionName>
  // Allows a client to receive output for multiple sessions simultaneously.
  // The primary session (via client-tracker) handles input/resize; subscriptions
  // add output-only routing for additional sessions.
  const subscriptions = new Map();

  // Data-available notifications: when a session produces output, notify
  // subscribed clients so they can pull data at their own pace.  Coalesced
  // via setImmediate so rapid %output lines within a single I/O cycle
  // produce one notification, not hundreds.  The notification carries no
  // payload — clients pull from the RingBuffer using their own cursor.
  const notificationPending = new Map();  // sessionName -> Immediate handle
  const resyncTimers = new Map();  // sessionName -> Timer handle

  function notifyDataAvailable(sessionName) {
    if (notificationPending.has(sessionName)) return; // already scheduled
    notificationPending.set(sessionName, setImmediate(() => {
      notificationPending.delete(sessionName);
      bridge.relay({ type: "data-available", session: sessionName });
    }));
    // Reset resync idle timer — session is actively producing output
    resetResyncTimer(sessionName);
  }

  function resetResyncTimer(_sessionName) {
    // Disabled: periodic resync used serializeScreen() which captures
    // mid-frame TUI state, causing garble in long-running sessions.
    // The pull mechanism + terminal pool handles state correctly.
  }

  function cancelResyncTimer(sessionName) {
    const timer = resyncTimers.get(sessionName);
    if (timer) { clearTimeout(timer); resyncTimers.delete(sessionName); }
  }

  function fireResync(sessionName) {
    const session = sessions.get(sessionName);
    if (!session?.alive) return;
    // Only fire if at least one client is subscribed
    if (!hasSubscribers(sessionName)) return;
    const snapshot = session.serializeScreen();
    if (!snapshot) return;
    const seq = session.outputBuffer.totalBytes;
    bridge.relay({ type: "resync", session: sessionName, data: snapshot, seq });
  }

  function hasSubscribers(sessionName) {
    // Check subscriptions map and tracker for any client viewing this session
    for (const [, subs] of subscriptions) {
      if (subs.has(sessionName)) return true;
    }
    // Also check primary attachments via tracker
    return tracker.hasClients(sessionName);
  }

  function cancelNotification(sessionName) {
    const handle = notificationPending.get(sessionName);
    if (handle) { clearImmediate(handle); notificationPending.delete(sessionName); }
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
      maxBufferBytes: MAX_BUFFER_BYTES,
      external,
      onData: (sessionName, _data) => {
        notifyDataAvailable(sessionName);
      },
      onExit: (sessionName, exitCode) => {
        log.info("Session exited", { session: sessionName, exitCode });
        bridge.relay({ type: "exit", session: sessionName, code: exitCode });
      },
    });

    session.attachControlMode(cols, rows);

    // Note: we intentionally do NOT push captureScrollback output into the
    // RingBuffer.  The RingBuffer must contain only raw %output escape
    // sequences so that pull data is always a valid terminal byte stream.
    // Mixing rendered capture-pane snapshots with raw %output corrupts
    // pull responses (rendered text uses different escape sequences than
    // the original stream, causing garbled display when replayed).
    //
    // Each client gets a fresh captureScrollback on attach — the RingBuffer
    // is only used for pull-based live output delivery after seq-init.

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
      scheduleSave();
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
      // Cancel any pending data-available notification and resync timer before removing
      cancelNotification(name);
      cancelResyncTimer(name);
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
      scheduleSave();
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

      // Cancel pending notification and resync timer under the old name before renaming.
      cancelNotification(oldName);
      cancelResyncTimer(oldName);

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
      scheduleSave();
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

      tracker.attach(clientId, name, cols, rows);

      cancelNotification(name);
      const buffer = session.alive ? session.serializeScreen() : "";
      const seq = session.outputBuffer.totalBytes;
      // Resize AFTER serialize to avoid race with tmux redraws.
      // This ensures the PTY matches the client's dimensions for
      // all future output (especially TUI apps like Claude Code).
      if (session.alive && cols && rows) session.resize(cols, rows);
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
      subscriptions.delete(clientId); // clear all subscriptions
    },

    /**
     * Subscribe a client to receive output from an additional session.
     * Captures a scrollback snapshot so the client sees existing content
     * (carousel tiles would otherwise be blank until new output arrives).
     * @param {string} clientId
     * @param {string} sessionName
     * @returns {Promise<{ buffer: string, seq: number, alive: boolean }>}
     */
    async subscribeClient(clientId, sessionName) {
      if (!sessionName) throw new Error("Session name required");
      const session = sessions.get(sessionName);
      if (!session) throw new Error(`Session "${sessionName}" not found`);

      if (!subscriptions.has(clientId)) {
        subscriptions.set(clientId, new Set());
      }
      subscriptions.get(clientId).add(sessionName);

      cancelNotification(sessionName);
      const buffer = session.alive ? session.serializeScreen() : "";
      const seq = session.outputBuffer.totalBytes;
      return { buffer, seq, alive: session.alive };
    },

    /**
     * Unsubscribe a client from a session's output.
     * @param {string} clientId
     * @param {string} sessionName
     */
    unsubscribeClient(clientId, sessionName) {
      const subs = subscriptions.get(clientId);
      if (subs) {
        subs.delete(sessionName);
        if (subs.size === 0) subscriptions.delete(clientId);
      }
    },

    /**
     * Check if a client should receive output for a session
     * (either primary attachment or subscription).
     * @param {string} clientId
     * @param {string} sessionName
     * @returns {boolean}
     */
    isClientSubscribedTo(clientId, sessionName) {
      // Primary session counts as subscribed
      if (tracker.getSessionFor(clientId) === sessionName) return true;
      const subs = subscriptions.get(clientId);
      return subs ? subs.has(sessionName) : false;
    },

    /**
     * Get all subscriptions for a client.
     * @param {string} clientId
     * @returns {Set<string>}
     */
    getSubscriptionsForClient(clientId) {
      return subscriptions.get(clientId) || new Set();
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
     * Resize a session's PTY directly by name (e.g. carousel card resize).
     * @param {string} sessionName
     * @param {number} cols
     * @param {number} rows
     */
    resizeSession(sessionName, cols, rows) {
      const session = sessions.get(sessionName);
      if (session?.alive) session.resize(cols, rows);
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
     * Restore sessions from sessions.json, re-adopting tmux sessions that still exist.
     */
    async restoreSessions() {
      if (!sessionsJsonPath) return;
      let map;
      try {
        const raw = readFileSync(sessionsJsonPath, "utf-8");
        map = JSON.parse(raw);
      } catch {
        // File missing or corrupt — start fresh
        return;
      }
      if (!map || typeof map !== "object" || Array.isArray(map)) return;

      for (const [friendlyName, tmuxName] of Object.entries(map)) {
        if (typeof tmuxName !== "string") continue;
        if (sessions.has(friendlyName)) continue;
        if (isAlreadyManaged(tmuxName)) continue;
        try {
          const exists = await tmuxHasSession(tmuxName);
          if (!exists) continue;
          const session = await adoptSession(friendlyName, tmuxName);
          sessions.set(friendlyName, session);
          log.info("Restored session", { session: friendlyName, tmux: tmuxName });
        } catch (err) {
          log.warn("Failed to restore session", { session: friendlyName, error: err.message });
        }
      }

      // Migrate sessions from old column widths to FIXED_COLS.
      // Pre-v0.44 used DEFAULT_COLS=120. Resize any restored session
      // that isn't at 80 cols so the PTY matches the client.
      for (const [name, session] of sessions) {
        if (session.alive && session._cols !== DEFAULT_COLS) {
          const oldCols = session._cols;
          session.resize(DEFAULT_COLS, session._rows || DEFAULT_ROWS);
          log.info("Migrated session cols", { session: name, from: oldCols, to: DEFAULT_COLS });
        }
      }
    },

    /**
     * Shutdown: close control mode processes but leave tmux sessions alive.
     */
    shutdown() {
      clearInterval(childCountTimer);
      for (const handle of notificationPending.values()) clearImmediate(handle);
      notificationPending.clear();
      for (const timer of resyncTimers.values()) clearTimeout(timer);
      resyncTimers.clear();
      // Flush any pending debounced save and write final state
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      saveSessionsSync();
      for (const [, session] of sessions) {
        session.detach();
      }
    },
  };
}

export { checkTmux, cleanTmuxServerEnv, setTmuxKatulongEnv };
