/**
 * Session Manager
 *
 * Manages terminal sessions backed by tmux. Extracted from daemon.js to run
 * directly inside server.js — no separate daemon process or IPC needed.
 *
 * tmux provides session persistence, multiplexing, and lifecycle management.
 * This module wraps tmux with a Session class (control mode I/O) and provides
 * the API for session CRUD, client attach/detach, and terminal I/O.
 */

import { execFile } from "node:child_process";
import { log } from "./log.js";
import { getSafeEnv } from "./env-filter.js";
import {
  Session, tmuxSessionName, tmuxExec, tmuxNewSession, tmuxHasSession,
  applyTmuxSessionOptions, captureScrollback, checkTmux, cleanTmuxServerEnv,
  tmuxListSessions, tmuxKillSession, tmuxListSessionsDetailed,
} from "./session.js";

const MAX_BUFFER = 5000;
const MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_SESSIONS = 20;
const CHILD_COUNT_INTERVAL_MS = 5000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const RESIZE_TOGGLE_DELAY_MS = 50;

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
  const clients = new Map(); // clientId -> { session: string }
  const pendingOps = new Map(); // name -> Promise<Session> (serializes concurrent spawns)
  const detachedNames = new Set(); // tmux names of sessions detached from katulong

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

  const childCountTimer = setInterval(async () => {
    for (const [name, session] of sessions) {
      if (!session.alive) continue;
      const count = await countTmuxPaneProcesses(session.tmuxName);
      session.lastKnownChildCount = count;
      bridge.relay({ type: "child-count-update", session: name, count });
    }
  }, CHILD_COUNT_INTERVAL_MS);
  childCountTimer.unref();

  // --- Shared helper: adopt an existing tmux session ---

  async function adoptSession(name, tmuxName, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    await applyTmuxSessionOptions(tmuxName);

    const session = new Session(name, tmuxName, {
      maxBufferItems: MAX_BUFFER,
      maxBufferBytes: MAX_BUFFER_BYTES,
      onData: (sessionName, data) => {
        bridge.relay({ type: "output", session: sessionName, data });
      },
      onExit: (sessionName, exitCode) => {
        log.info("Session exited", { session: sessionName, exitCode });
        bridge.relay({ type: "exit", session: sessionName, code: exitCode });
      },
    });

    session.attachControlMode(cols, rows);

    const scrollback = await captureScrollback(tmuxName);
    if (scrollback) {
      session.outputBuffer.push(scrollback);
    }

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
    // Serialize concurrent spawns for the same session name
    const pending = pendingOps.get(name);
    if (pending) return pending;

    const promise = doSpawnSession(name, cols, rows, cwd).finally(() => {
      pendingOps.delete(name);
    });
    pendingOps.set(name, promise);
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

    if (!exists) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      session.write("\x0C");
    }

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
      session = await adoptSession(tmuxName, tmuxName, cols, rows);
    } catch (err) {
      log.warn("Failed to adopt tmux session", { tmuxName, error: err.message });
      return { error: "Failed to adopt session" };
    }

    // Re-check after async work (guards against races with spawnSession)
    if (isAlreadyManaged(tmuxName)) {
      session.detach();
      return { error: "Session already managed" };
    }

    session.external = true;
    sessions.set(tmuxName, session);
    detachedNames.delete(tmuxName);
    log.info("Adopted tmux session", { tmuxName });
    return { name: tmuxName };
  }

  function aliveSessionFor(clientId) {
    const info = clients.get(clientId);
    if (!info) return null;
    const session = sessions.get(info.session);
    return session?.alive ? session : null;
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
      if (sessions.size >= MAX_SESSIONS) return { error: `Maximum session limit (${MAX_SESSIONS}) reached` };
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
      if (sessions.size >= MAX_SESSIONS) return { error: `Maximum session limit (${MAX_SESSIONS}) reached` };
      if (sessions.has(name)) return { error: "Session already exists" };

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
      const tmuxName = session.tmuxName;
      if (detachOnly) {
        // Detach: close control mode but keep tmux session alive
        session.detach();
        detachedNames.add(tmuxName);
      } else {
        // Delete: kill the tmux session
        session.kill();
        detachedNames.delete(tmuxName);
      }
      const action = detachOnly ? "detached" : "deleted";
      sessions.delete(name);
      for (const [cid, info] of clients) {
        if (info.session === name) clients.delete(cid);
      }
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

      // Rename the underlying tmux session
      const newTmuxName = tmuxSessionName(newName);
      const { code } = await tmuxExec(["rename-session", "-t", session.tmuxName, newTmuxName]);
      if (code !== 0) return { error: "Failed to rename tmux session" };

      session.name = newName;
      session.tmuxName = newTmuxName;
      sessions.delete(oldName);
      sessions.set(newName, session);
      for (const [, info] of clients) {
        if (info.session === oldName) info.session = newName;
      }
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
      const name = sessionName || "default";
      let session = sessions.get(name);
      if (!session) {
        session = await spawnSession(name, cols, rows);
      }
      clients.set(clientId, { session: name });
      // Set correct dimensions, then toggle ±1 column via deferred resize
      // to trigger SIGWINCH so TUI apps (vim, Claude Code) redraw via
      // live %output. No buffer replay — avoids garbled cursor escapes.
      if (session.alive) {
        session.resize(cols, rows);
        process.nextTick(() => {
          session.resize(Math.max(1, cols - 1), rows);
          setTimeout(() => session.resize(cols, rows), RESIZE_TOGGLE_DELAY_MS);
        });
      }
      return { buffer: "", alive: session.alive };
    },

    /**
     * Detach a client from its session.
     * The session stays managed (control mode stays attached) so the user can
     * reconnect without needing to re-adopt — important for mobile where
     * creating new tabs/windows is not practical.
     * @param {string} clientId
     */
    detachClient(clientId) {
      clients.delete(clientId);
    },

    /**
     * Write input to a client's session.
     * @param {string} clientId
     * @param {string} data
     */
    writeInput(clientId, data) {
      try {
        aliveSessionFor(clientId)?.write(data);
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
      aliveSessionFor(clientId)?.resize(cols, rows);
    },

    /**
     * Shutdown: close control mode processes but leave tmux sessions alive.
     */
    shutdown() {
      clearInterval(childCountTimer);
      for (const [, session] of sessions) {
        session.detach();
      }
    },
  };
}

export { checkTmux, cleanTmuxServerEnv };
