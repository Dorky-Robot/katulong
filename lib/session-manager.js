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
import { join } from "node:path";
import { log } from "./log.js";
import { getSafeEnv } from "./env-filter.js";
import {
  Session, tmuxSessionName, tmuxExec, tmuxNewSession, tmuxHasSession,
  applyTmuxSessionOptions, captureScrollback, checkTmux, tmuxListSessions,
} from "./session.js";
import { loadShortcuts, saveShortcuts } from "./shortcuts.js";

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
 * @param {string} opts.dataDir - Data directory for shortcuts file
 * @returns {object} Session manager API
 */
export function createSessionManager({ bridge, shell, home, dataDir }) {
  const sessions = new Map();
  const clients = new Map(); // clientId -> { session: string }

  const shortcutsPath = join(dataDir, "shortcuts.json");

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

  // --- Session discovery (adopt existing tmux sessions on startup) ---

  async function discoverSessions() {
    const tmuxSessions = await tmuxListSessions();
    let adopted = 0;

    for (const tmuxName of tmuxSessions) {
      if (sessions.has(tmuxName)) continue;

      try {
        const session = await adoptSession(tmuxName, tmuxName);

        // Re-check after async work to avoid race with attachClient/createSession
        if (sessions.has(tmuxName)) {
          session.kill();
          continue;
        }

        sessions.set(tmuxName, session);
        adopted++;
      } catch (err) {
        log.warn("Failed to adopt tmux session", { tmuxName, error: err.message });
      }
    }

    if (adopted > 0) {
      log.info("Discovered existing tmux sessions", { adopted, total: sessions.size });
    }
  }

  // Run discovery on startup
  discoverSessions();

  // --- Session operations ---

  async function spawnSession(name, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, cwd = null) {
    const tmuxName = tmuxSessionName(name);
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
    log.info("Session created", { session: name, tmux: tmuxName, reattached: exists });
    return session;
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
     * @returns {{ ok: true } | { error: string }}
     */
    deleteSession(name) {
      const session = sessions.get(name);
      if (!session) return { error: "Not found" };
      session.kill();
      sessions.delete(name);
      for (const [cid, info] of clients) {
        if (info.session === name) clients.delete(cid);
      }
      bridge.relay({ type: "session-removed", session: name });
      log.info("Session removed", { session: name });
      return { ok: true };
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
      return { buffer: session.getBuffer(), alive: session.alive };
    },

    /**
     * Detach a client from its session.
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
      try { aliveSessionFor(clientId)?.write(data); } catch { /* session died */ }
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
     * Load shortcuts from disk.
     * @returns {{ shortcuts: object[] }}
     */
    getShortcuts() {
      const result = loadShortcuts(shortcutsPath);
      return { shortcuts: result.success ? result.data : [] };
    },

    /**
     * Save shortcuts to disk.
     * @param {object[]} data
     * @returns {{ ok: true } | { error: string }}
     */
    setShortcuts(data) {
      const result = saveShortcuts(shortcutsPath, data);
      return result.success ? { ok: true } : { error: result.message };
    },

    /**
     * Shutdown: close control mode processes but leave tmux sessions alive.
     */
    shutdown() {
      clearInterval(childCountTimer);
      for (const [, session] of sessions) {
        if (session.controlProc) {
          try {
            session.controlProc.stdin.end();
            session.controlProc.kill();
          } catch { /* already dead */ }
        }
      }
    },
  };
}

export { checkTmux };
