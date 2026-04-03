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
import { ClientHeadless } from "./client-headless.js";
import { Session } from "./session.js";
import {
  tmuxSessionName, tmuxExec, tmuxNewSession, tmuxHasSession,
  applyTmuxSessionOptions, captureScrollback, captureVisiblePane, getCursorPosition, getPaneCwd, checkTmux,
  cleanTmuxServerEnv, setTmuxKatulongEnv, tmuxListSessions, tmuxKillSession, tmuxListSessionsDetailed,
} from "./tmux.js";
import { DEFAULT_COLS, TERMINAL_ROWS_DEFAULT } from "./terminal-config.js";

/**
 * Per-client headless map for attach/subscribe serialization and drift detection.
 *
 * Maps "clientId:sessionName" -> ClientHeadless instances so each client
 * gets terminal snapshots and fingerprints computed at its own dimensions.
 * Shared across tests and session-manager internals.
 *
 * @returns {object} Map API with register, remove, removeClient, getBySession, get, disposeAll
 */
export function createClientHeadlessMap() {
  // key: "clientId:sessionName" -> { clientId, sessionName, headless: ClientHeadless }
  const entries = new Map();

  return {
    /**
     * Register a client's headless terminal for a session.
     * @param {string} clientId
     * @param {string} sessionName
     * @param {import("./ring-buffer.js").RingBuffer} ringBuffer
     * @param {number} cols
     * @param {number} rows
     * @returns {ClientHeadless}
     */
    register(clientId, sessionName, ringBuffer, cols, rows) {
      const key = `${clientId}:${sessionName}`;
      // Dispose existing if re-registering (e.g., reconnect with new dims)
      const existing = entries.get(key);
      if (existing) existing.headless.dispose();
      const headless = new ClientHeadless(ringBuffer, cols, rows);
      entries.set(key, { clientId, sessionName, headless });
      return headless;
    },

    /**
     * Remove a specific client-session entry.
     * @param {string} clientId
     * @param {string} sessionName
     */
    remove(clientId, sessionName) {
      const key = `${clientId}:${sessionName}`;
      const entry = entries.get(key);
      if (entry) {
        entry.headless.dispose();
        entries.delete(key);
      }
    },

    /**
     * Remove all entries for a client (disconnect cleanup).
     * @param {string} clientId
     */
    removeClient(clientId) {
      for (const [key, entry] of entries) {
        if (entry.clientId === clientId) {
          entry.headless.dispose();
          entries.delete(key);
        }
      }
    },

    /**
     * Remove all entries for a session (session deletion cleanup).
     * @param {string} sessionName
     */
    removeSession(sessionName) {
      for (const [key, entry] of entries) {
        if (entry.sessionName === sessionName) {
          entry.headless.dispose();
          entries.delete(key);
        }
      }
    },

    /**
     * Get the headless terminal for a specific client-session pair.
     * @param {string} clientId
     * @param {string} sessionName
     * @returns {ClientHeadless|undefined}
     */
    get(clientId, sessionName) {
      const entry = entries.get(`${clientId}:${sessionName}`);
      return entry?.headless;
    },

    /**
     * Get all headless entries for a given session.
     * @param {string} sessionName
     * @returns {{ clientId: string, headless: ClientHeadless }[]}
     */
    getBySession(sessionName) {
      const result = [];
      for (const entry of entries.values()) {
        if (entry.sessionName === sessionName) {
          result.push({ clientId: entry.clientId, headless: entry.headless });
        }
      }
      return result;
    },

    /**
     * Dispose all entries and clear the map.
     */
    disposeAll() {
      for (const entry of entries.values()) entry.headless.dispose();
      entries.clear();
    },
  };
}

const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20 MB per session
const MAX_SESSIONS = 20;
const CHILD_COUNT_INTERVAL_MS = 5000;
const DEFAULT_ROWS = TERMINAL_ROWS_DEFAULT;

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

  // Per-client headless map for serialization and drift detection (PCH-2/PCH-3).
  // Each client gets its own headless xterm at its dimensions so fingerprints
  // are computed per-client, not broadcast from a shared headless.
  const clientHeadlessMap = createClientHeadlessMap();

  // Multi-session subscriptions: clientId -> Set<sessionName>
  // Allows a client to receive output for multiple sessions simultaneously.
  // The primary session (via client-tracker) handles input/resize; subscriptions
  // add output-only routing for additional sessions.
  const subscriptions = new Map();

  // Data-available notifications: when a session produces output, push data
  // inline to clients.  Coalesced via setImmediate so rapid %output lines
  // within a single I/O cycle produce one message, not hundreds.  The relay
  // includes the batch data so ws-manager can push it directly to clients
  // (zero round trips).  Clients fall back to pull on cursor mismatch.
  // Drift detection: after output settles (no new data for IDLE_CHECK_MS),
  // compute a screen fingerprint and send it to clients.  Clients compare
  // against their own xterm state — on mismatch they request a resync.
  // This catches ALL sources of corruption (resize races, WS drops,
  // browser throttling, backpressure edge cases) without needing to
  // identify each one.  Zero overhead during active output.
  const IDLE_CHECK_MS = 500;
  const idleCheckTimers = new Map();

  function scheduleIdleCheck(sessionName) {
    clearTimeout(idleCheckTimers.get(sessionName));
    idleCheckTimers.set(sessionName, setTimeout(async () => {
      idleCheckTimers.delete(sessionName);
      const session = sessions.get(sessionName);
      if (!session?.alive) return;

      // Per-client drift detection: compute a fingerprint for each
      // client at its own dimensions, then send targeted state-check messages.
      const clientEntries = clientHeadlessMap.getBySession(sessionName);
      if (clientEntries.length > 0) {
        for (const { clientId, headless } of clientEntries) {
          const fp = await headless.screenFingerprint();
          bridge.relay({ type: "state-check", session: sessionName, fingerprint: fp, clientId });
        }
      } else {
        // Fallback: no per-client headless registered (backward compat).
        // Use the shared session headless to broadcast to all clients.
        const fingerprint = await session.screenFingerprint();
        bridge.relay({ type: "state-check", session: sessionName, fingerprint });
      }
    }, IDLE_CHECK_MS));
  }

  // Output coalescing: debounce pattern (2ms idle + 16ms hard cap).
  //
  // TUI apps like Claude Code render full-screen frames that span many
  // tmux %output lines.  Node.js may deliver these across multiple I/O
  // ticks, so setImmediate coalescing only captures one tick's worth.
  // A 2ms idle timer waits for output to stop arriving; a 16ms hard cap
  // (one 60fps frame) ensures continuous streams don't starve delivery.
  // This sends complete (or near-complete) frames in a single bridge
  // relay, which transports (WS, DataChannel, etc.) then deliver as one
  // message — preventing partial-frame rendering artifacts.
  const _outputCoalesce = new Map();  // sessionName -> { fromSeq, idle, cap }
  function notifyDataAvailable(sessionName, fromSeq) {
    let pending = _outputCoalesce.get(sessionName);
    if (pending) {
      // Reset idle timer — more output arriving
      clearTimeout(pending.idle);
      pending.idle = setTimeout(() => _flushOutput(sessionName), 2);
      return;
    }
    pending = {
      fromSeq,
      idle: setTimeout(() => _flushOutput(sessionName), 2),
      cap: setTimeout(() => _flushOutput(sessionName), 16),
    };
    _outputCoalesce.set(sessionName, pending);
  }

  function _flushOutput(sessionName) {
    const pending = _outputCoalesce.get(sessionName);
    if (!pending) return;
    clearTimeout(pending.idle);
    clearTimeout(pending.cap);
    _outputCoalesce.delete(sessionName);

    const session = sessions.get(sessionName);
    if (!session) return;
    const cursor = session.outputBuffer.totalBytes;
    const data = session.outputBuffer.sliceFrom(pending.fromSeq);
    if (data && data.length > 0) {
      bridge.relay({ type: "output", session: sessionName, data, fromSeq: pending.fromSeq, cursor });
      scheduleIdleCheck(sessionName);
    }
  }

  function cancelNotification(sessionName) {
    const pending = _outputCoalesce.get(sessionName);
    if (pending) {
      clearTimeout(pending.idle);
      clearTimeout(pending.cap);
      _outputCoalesce.delete(sessionName);
    }
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
    // Only apply tmux options for externally adopted sessions —
    // new sessions already have them from tmuxNewSession().
    if (external) await applyTmuxSessionOptions(tmuxName);

    const session = new Session(name, tmuxName, {
      maxBufferBytes: MAX_BUFFER_BYTES,
      external,
      onData: (sessionName, fromSeq) => {
        notifyDataAvailable(sessionName, fromSeq);
      },
      onExit: (sessionName, exitCode) => {
        log.info("Session exited", { session: sessionName, exitCode });
        bridge.relay({ type: "exit", session: sessionName, code: exitCode });

        // Immediately delete the exited session — same behavior as a local
        // terminal (Terminal.app, iTerm2) closing when the shell exits.
        deleteSession(sessionName);
      },
    });

    session.attachControlMode(cols, rows);

    // Seed the headless terminal with the current tmux pane content.
    //
    // After a server restart (or for any newly adopted session), the
    // headless xterm is empty because tmux control mode only sends
    // %output for NEW data — it does not replay the existing screen.
    // For idle sessions this means serializeScreen() returns empty
    // content, causing blank tiles on the client.
    //
    // captureVisiblePane() gets the current screen with ANSI escapes,
    // and getCursorPosition() gets the cursor location.  Writing both
    // to the headless seeds it so serializeScreen() returns meaningful
    // content immediately, even before any %output arrives.
    //
    // Note: this content goes into the headless ONLY, not the RingBuffer.
    // The RingBuffer must contain only raw %output escape sequences so
    // that pull data is always a valid terminal byte stream.
    const [visibleContent, cursorPos] = await Promise.all([
      captureVisiblePane(tmuxName),
      getCursorPosition(tmuxName),
    ]);
    await session.seedScreen(visibleContent, cursorPos);

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

  /**
   * Delete a session (internal function shared by public API and auto-cleanup).
   * @param {string} name
   * @param {{ detachOnly?: boolean }} [opts]
   * @returns {{ ok: true, action: string } | { error: string }}
   */
  function deleteSession(name, { detachOnly = false } = {}) {
    const session = sessions.get(name);
    if (!session) return { error: "Not found" };
    // Cancel any pending data-available notification and drift check before removing
    cancelNotification(name);
    clearTimeout(idleCheckTimers.get(name));
    idleCheckTimers.delete(name);
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
    clientHeadlessMap.removeSession(name);
    bridge.relay({ type: "session-removed", session: name });
    log.info("Session removed", { session: name, action });
    scheduleSave();
    return { ok: true, action };
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
    let evicted = false;
    for (const [key, s] of sessions) {
      if (s.tmuxName === tmuxName && key !== name) {
        s.detach();
        sessions.delete(key);
        evicted = true;
        break;
      }
    }

    // Only check tmux if we evicted a session (possible orphan) — skip
    // for brand new names since tmuxNewSession will fail if it exists.
    const exists = evicted ? await tmuxHasSession(tmuxName) : false;

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
     * Get the current working directory of a session's terminal.
     * @param {string} sessionName
     * @returns {Promise<string|null>}
     */
    async getSessionCwd(sessionName) {
      const session = sessions.get(sessionName);
      if (!session) return null;
      return getPaneCwd(session.tmuxName);
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

    deleteSession: deleteSession,

    /**
     * Rename a session.
     * @param {string} oldName
     * @param {string} newName
     * @returns {{ name: string } | { error: string }}
     */
    async renameSession(oldName, newName) {
      const session = sessions.get(oldName);
      if (!session || sessions.has(newName)) return { error: "Not found or name taken" };

      // Cancel pending notification under the old name before renaming.
      cancelNotification(oldName);

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

      let buffer = "";
      if (session.alive && cols && rows) {
        // Register per-client headless at this client's dimensions.
        // Replays the session's RingBuffer so the headless state is current,
        // then serialize from it. This avoids resizing the shared headless
        // (which would garble other clients viewing the same session at
        // different dimensions).
        const ch = clientHeadlessMap.register(clientId, name, session.outputBuffer, cols, rows);
        const snap = await ch.serializeScreen();
        // null means RingBuffer evicted past the headless cursor — fall back
        buffer = snap ?? await session.serializeScreen() ?? "";
      } else if (session.alive) {
        // No dimensions — fall back to shared headless (PCH-7 removes this)
        buffer = await session.serializeScreen();
      }
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
      subscriptions.delete(clientId); // clear all subscriptions
      clientHeadlessMap.removeClient(clientId);
    },

    /**
     * Subscribe a client to receive output from an additional session.
     * Captures a scrollback snapshot so the client sees existing content
     * (carousel tiles would otherwise be blank until new output arrives).
     * @param {string} clientId
     * @param {string} sessionName
     * @returns {Promise<{ buffer: string, seq: number, alive: boolean }>}
     */
    async subscribeClient(clientId, sessionName, cols, rows) {
      if (!sessionName) throw new Error("Session name required");
      const session = sessions.get(sessionName);
      if (!session) throw new Error(`Session "${sessionName}" not found`);

      if (!subscriptions.has(clientId)) {
        subscriptions.set(clientId, new Set());
      }
      const subs = subscriptions.get(clientId);
      const alreadySubscribed = subs.has(sessionName);
      subs.add(sessionName);

      // Only serialize on first subscribe (fresh terminal after page refresh).
      // Re-subscribes (carousel swipe) skip serialize to avoid mid-frame garble.
      cancelNotification(sessionName);

      // Re-subscribe with changed dimensions: update the headless so drift
      // fingerprints match the new viewport (no serialization on re-subscribe).
      if (alreadySubscribed && cols && rows) {
        const existing = clientHeadlessMap.get(clientId, sessionName);
        if (existing && (existing.cols !== cols || existing.rows !== rows)) {
          clientHeadlessMap.register(clientId, sessionName, session.outputBuffer, cols, rows);
        }
      }

      let buffer = "";
      if (!alreadySubscribed && session.alive && cols && rows) {
        // Register per-client headless at this client's dimensions and serialize
        // from it. Same pattern as attachClient — avoids shared headless resize.
        const ch = clientHeadlessMap.register(clientId, sessionName, session.outputBuffer, cols, rows);
        const snap = await ch.serializeScreen();
        buffer = snap ?? await session.serializeScreen() ?? "";
      } else if (!alreadySubscribed && session.alive) {
        // No dimensions — fall back to shared headless (PCH-7 removes this)
        buffer = await session.serializeScreen();
      }
      const seq = session.outputBuffer.totalBytes;
      return { buffer, seq, alive: session.alive, isNew: !alreadySubscribed };
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
      clientHeadlessMap.remove(clientId, sessionName);
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
     * Get the per-client headless terminal for a client-session pair.
     * Used by ws-manager for resync/pull-snapshot serialization.
     * @param {string} clientId
     * @param {string} sessionName
     * @returns {ClientHeadless|undefined}
     */
    getClientHeadless(clientId, sessionName) {
      return clientHeadlessMap.get(clientId, sessionName);
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

      // Filter candidates synchronously, then restore in parallel.
      const candidates = Object.entries(map).filter(
        ([friendlyName, tmuxName]) =>
          typeof tmuxName === "string" &&
          !sessions.has(friendlyName) &&
          !isAlreadyManaged(tmuxName)
      );

      await Promise.allSettled(
        candidates.map(async ([friendlyName, tmuxName]) => {
          const exists = await tmuxHasSession(tmuxName);
          if (!exists) return;
          const session = await adoptSession(friendlyName, tmuxName);
          sessions.set(friendlyName, session);
          log.info("Restored session", { session: friendlyName, tmux: tmuxName });
        })
      ).then(results => {
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "rejected") {
            const [friendlyName] = candidates[i];
            log.warn("Failed to restore session", { session: friendlyName, error: results[i].reason?.message });
          }
        }
      });

      // Note: we intentionally do NOT resize restored sessions to DEFAULT_COLS.
      // Column width is now variable — each client calculates its own cols
      // from viewport width and sends them via attach/resize. Forcing a
      // resize here would override the last client's negotiated dimensions.
    },

    /**
     * Shutdown: close control mode processes but leave tmux sessions alive.
     */
    shutdown() {
      clearInterval(childCountTimer);
      for (const p of _outputCoalesce.values()) { clearTimeout(p.idle); clearTimeout(p.cap); }
      _outputCoalesce.clear();
      for (const t of idleCheckTimers.values()) clearTimeout(t);
      idleCheckTimers.clear();
      clientHeadlessMap.disposeAll();
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
