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
import { createOutputCoalescer } from "./output-coalescer.js";
import { driftLog, driftLogLevel } from "./drift-log.js";
import { createSessionStore } from "./session-persistence.js";
import { startChildCountMonitor } from "./session-child-counter.js";
import { Session } from "./session.js";
import { sessionId, SESSION_ID_PATTERN } from "./id.js";
import { publicMeta } from "./session-meta-filter.js";
import {
  tmuxExec, tmuxNewSession, tmuxHasSession,
  applyTmuxSessionOptions, captureVisiblePane, getCursorPosition, getPaneCwd, checkTmux,
  cleanTmuxServerEnv, setTmuxKatulongEnv, tmuxListSessions, tmuxKillSession, tmuxListSessionsDetailed,
  tmuxSocketArgs, tmuxGetPaneId,
} from "./tmux.js";
import { DEFAULT_COLS, TERMINAL_ROWS_DEFAULT } from "./terminal-config.js";

const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20 MB per session
const MAX_SESSIONS = 20;
const DEFAULT_ROWS = TERMINAL_ROWS_DEFAULT;

/**
 * Strip transient claude fields so only hook-owned durable keys survive
 * persistence. `running` / `detectedAt` are written by the child-count
 * monitor and re-derived on every startup from live tmux state —
 * persisting them would surface stale "running" after a restart where
 * the pane is actually idle. `uuid` / `startedAt` come from Claude hook
 * events and are what the feed tile needs to keep resolving to the same
 * topic across a server restart.
 *
 * Returns the `{...meta}` shape suitable for writing to sessions.json.
 */
export function persistableMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const { claude, ...rest } = meta;
  if (!claude || typeof claude !== "object" || Array.isArray(claude)) return rest;
  const { running: _r, detectedAt: _d, ...durable } = claude;
  if (Object.keys(durable).length === 0) return rest;
  return { ...rest, claude: durable };
}

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
  const pendingOps = new Map(); // friendly name (spawn) or tmuxName (adopt) -> Promise<Session>; key is whatever will end up as the sessions-map key, so spawn+adopt for the same slot serialize
  const detachedNames = new Set(); // tmux names of sessions detached from katulong

  // Session persistence — debounced writes to sessions.json.
  // The store is a thin wrapper around fs; it only knows how to serialize
  // whatever plain object this callback returns, keeping the persistence
  // concern independent of the Session class.
  //
  // Entry shape: { tmuxName, id, tmuxPane }. Legacy entries (a raw tmuxName
  // string or a `{ tmuxName, id }` object with no tmuxPane) are accepted on
  // load — see restoreSessions — and rewritten on the next scheduleSave().
  // `tmuxPane` is recaptured live on restore anyway, so persisting it is
  // defense-in-depth for cases where the capture fails during startup.
  const store = createSessionStore({
    dataDir,
    serialize: () => {
      const obj = {};
      for (const [name, session] of sessions) {
        const persistMeta = persistableMeta(session.meta);
        const entry = {
          tmuxName: session.tmuxName,
          id: session.id,
          tmuxPane: session.tmuxPane,
        };
        if (Object.keys(persistMeta).length > 0) entry.meta = persistMeta;
        obj[name] = entry;
      }
      return obj;
    },
  });
  const scheduleSave = store.scheduleSave;

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

      // Drift detection: compute a single fingerprint from the shared
      // session headless (which is written live at the current PTY dims)
      // and broadcast it to every client viewing this session. Per-client
      // fingerprints were tried in PCH-3 and removed in PCH-7 — replaying
      // RingBuffer history into a differently-sized headless produces
      // drift, not correctness (see CLAUDE.md "Multi-device terminal
      // dimensions — inherent PTY limitation").
      //
      // The fingerprint is paired with `seq` (byte position in the output
      // stream that the hash describes). Without seq the client compares
      // hashes from different points in the stream and reports false drift.
      const { hash: fingerprint, seq } = await session.screenFingerprint();
      bridge.relay({ type: "state-check", session: sessionName, fingerprint, seq });
    }, IDLE_CHECK_MS));
  }

  // Output coalescing: the OutputCoalescer owns the 2ms idle + 16ms cap
  // timers. This manager only provides the onFlush callback that pulls
  // bytes from the session and relays them to clients. See
  // lib/output-coalescer.js for the debounce semantics and rationale.
  const outputCoalescer = createOutputCoalescer({
    onFlush: (sessionName, fromSeq) => {
      const session = sessions.get(sessionName);
      if (!session) return;
      const { data, cursor } = session.pullFrom(fromSeq);
      if (data && data.length > 0) {
        // Drift probe: if the flushed payload contains U+FFFD, log it so
        // we can tell whether the corruption is upstream of the relay
        // (tmux parser / octal unescape / payload UTF-8 decoder) or
        // client-side. Only scanned when drift logging is on, since
        // iterating every flushed byte on every flush is not free.
        if (driftLogLevel() >= 1) {
          let fffdCount = 0;
          for (let i = 0; i < data.length; i++) {
            if (data.charCodeAt(i) === 0xFFFD) fffdCount++;
          }
          if (fffdCount > 0) {
            // Log metadata only — no terminal content. This log can be
            // left on for days, and terminal output can include sensitive
            // material (prompts adjacent to password inputs, API keys
            // printed by scripts, file contents). We capture enough to
            // correlate with client-side drift without persisting bytes.
            driftLog({
              event: "flush-fffd",
              session: sessionName,
              fromSeq,
              toCursor: cursor,
              bytes: data.length,
              fffd: fffdCount,
              firstFffdOffset: data.indexOf("\uFFFD"),
            });
          }
        }
        bridge.relay({ type: "output", session: sessionName, data, fromSeq, cursor });
        scheduleIdleCheck(sessionName);
      }
    },
  });


  // Client tracker handles multi-client multiplexing and resize arbitration
  const tracker = createClientTracker({
    bridge,
    getSession: (name) => sessions.get(name),
  });

  // Periodic child-process counting + dead-session reaping. The monitor
  // knows nothing about tmux internals beyond countTmuxPaneProcesses and
  // talks back to the session manager via the shared sessions Map + bridge.
  const childCountMonitor = startChildCountMonitor({ sessions, tracker, bridge });

  function aliveSessionCount() {
    let count = 0;
    for (const s of sessions.values()) {
      if (s.alive) count++;
    }
    return count;
  }

  // --- Shared helper: adopt an existing tmux session ---

  async function adoptSession(name, tmuxName, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, { external = false, id = null, meta = null } = {}) {
    // Only apply tmux options for externally adopted sessions —
    // new sessions already have them from tmuxNewSession().
    if (external) await applyTmuxSessionOptions(tmuxName);

    // Capture the tmux pane id (`%N`) now — it's stable for the pane's
    // lifetime and used by the claude hook pipeline to answer
    // "which claude UUID is running in this katulong tile?". See
    // docs/tile-claude-session-link.md. Failing to capture is not fatal:
    // we fall back to null and the claude lookup simply won't match for
    // this session until a restart or reattach.
    const tmuxPane = await tmuxGetPaneId(tmuxName);

    const session = new Session(name, tmuxName, {
      id: id != null ? id : sessionId(),
      tmuxPane,
      meta,
      maxBufferBytes: MAX_BUFFER_BYTES,
      external,
      onData: (sessionName, fromSeq) => {
        outputCoalescer.notify(sessionName, fromSeq);
      },
      onExit: (sessionName, exitCode) => {
        log.info("Session exited", { session: sessionName, exitCode });
        bridge.relay({ type: "exit", session: sessionName, code: exitCode });

        // Immediately delete the exited session — same behavior as a local
        // terminal (Terminal.app, iTerm2) closing when the shell exits.
        deleteSession(sessionName);
      },
      onChange: (s) => {
        scheduleSave();
        // Strip server-only meta keys before broadcast — same filter used
        // by the REST surfaces. Keeps a single source of truth for what
        // is or isn't safe to ship over the wire.
        const data = s.toJSON();
        bridge.relay({
          type: "session-updated",
          session: s.name,
          data: { ...data, meta: publicMeta(data.meta) },
        });
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
    // Flush any pending output to still-subscribed clients before removing.
    // Cancelling here would silently drop queued bytes — clients still
    // routed for this session would never see the final tail of output
    // (e.g. shell exit message before the session disappears).
    outputCoalescer.flush(name);
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
    bridge.relay({ type: "session-removed", session: name });
    log.info("Session removed", { session: name, action });
    scheduleSave();
    return { ok: true, action };
  }

  // --- Session operations ---

  async function spawnSession(name, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, cwd = null, id = null) {
    // Serialize on friendly name so concurrent spawns of the same name
    // collapse into a single promise. Adopt also keys pendingOps on the
    // friendly name it will store the session under (which equals the
    // tmuxName for adoption), so a spawn and adopt targeting the same
    // sessions-map key still serialize against each other.
    const pending = pendingOps.get(name);
    if (pending) return pending;

    const promise = doSpawnSession(name, cols, rows, cwd, id).finally(() => {
      pendingOps.delete(name);
    });
    pendingOps.set(name, promise);
    return promise;
  }

  async function doSpawnSession(name, cols, rows, cwd, explicitId) {
    // The surrogate id is the source of truth for the tmux session name
    // from MC1e onward — `kat_<id>` uses only characters tmux already
    // accepts (see lib/id.js), so no sanitization is needed.
    const id = explicitId != null ? explicitId : sessionId();
    const tmuxName = `kat_${id}`;

    const safeEnv = getSafeEnv();
    const env = {
      ...safeEnv,
      TERM: "xterm-256color",
      TERM_PROGRAM: "katulong",
      COLORTERM: "truecolor",
    };
    await tmuxNewSession(tmuxName, cols, rows, shell, env, cwd || home);

    const session = await adoptSession(name, tmuxName, cols, rows, { id });

    sessions.set(name, session);
    detachedNames.delete(tmuxName);
    log.info("Session created", { session: name, tmux: tmuxName });
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
    return { name: tmuxName, id: session.id };
  }

  // --- Public API ---

  return {
    /**
     * List all sessions.
     * @returns {{ sessions: object[] }}
     */
    listSessions() {
      return {
        sessions: [...sessions.values()].map(s => {
          const data = s.toJSON();
          return { ...data, meta: publicMeta(data.meta) };
        }),
      };
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

      let cwd = null;
      if (copyFrom) {
        const source = sessions.get(copyFrom);
        if (source) {
          const result = await new Promise((resolve) => {
            execFile("tmux", [...tmuxSocketArgs(), "display-message", "-t", source.tmuxName, "-p", "#{pane_current_path}"],
              { timeout: 5000 }, (err, stdout) => {
                resolve(err ? null : stdout.trim());
              });
          });
          cwd = result;
        }
      }

      const session = await spawnSession(name, cols, rows, cwd);
      scheduleSave();
      return { name, id: session.id };
    },

    deleteSession: deleteSession,

    /**
     * Rename a session.
     *
     * MC1e: rename only updates the katulong-facing friendly name. The
     * underlying tmux session (keyed by `kat_<id>` for new spawns or the
     * user's external name for adopted sessions) is NOT renamed — that was
     * the source of the rename-drift bugs documented in
     * docs/session-identity.md. Downstream consumers that need a stable
     * anchor should key by `id` or `tmuxPane`, not name.
     *
     * @param {string} oldName
     * @param {string} newName
     * @returns {{ name: string, id: string } | { error: string }}
     */
    async renameSession(oldName, newName) {
      const session = sessions.get(oldName);
      if (!session || sessions.has(newName)) return { error: "Not found or name taken" };

      // Flush pending notification under the old name before renaming so
      // currently-routed subscribers receive the queued bytes (cancelling
      // would silently drop them).
      outputCoalescer.flush(oldName);

      session.name = newName;
      sessions.delete(oldName);
      sessions.set(newName, session);
      tracker.renameSession(oldName, newName);
      bridge.relay({ type: "session-renamed", session: oldName, newName, id: session.id });
      log.info("Session renamed", { from: oldName, to: newName });
      scheduleSave();
      return { name: newName, id: session.id };
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
        session = await spawnSession(name, cols, rows);
      }

      tracker.attach(clientId, name, cols, rows);

      // Flush queued output before snapshotting so previously-subscribed
      // clients receive bytes that landed in the coalescer between the last
      // flush and this attach. Cancelling here (the prior behavior) silently
      // dropped those bytes for everyone — a liveness hole that left other
      // clients with stale terminals until the next %output burst arrived.
      outputCoalescer.flush(name);

      // Snapshot the shared session headless (Lamport-correct { buffer, seq }
      // pair). PCH-7 removed per-client replay because it could not correctly
      // re-interpret absolute cursor escapes at client-specific dims; the
      // shared headless is written live at the current PTY dims and reflows
      // in lockstep with tmux, so it always reflects truth.
      return await session.snapshot();
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

      // Flush queued output before snapshotting so existing subscribers see
      // bytes that landed in the coalescer before this subscribe — cancelling
      // (the prior behavior) silently dropped them.
      outputCoalescer.flush(sessionName);

      // Re-subscribes (carousel swipe) skip the snapshot to avoid mid-frame
      // garble — the client's xterm pool already has the content. First
      // subscribe gets a Lamport-correct snapshot from the shared headless.
      if (alreadySubscribed) {
        return { buffer: "", seq: session.cursor, alive: session.alive, isNew: false };
      }
      const snap = await session.snapshot();
      return { ...snap, isNew: true };
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
     * Get a session by its immutable surrogate id.
     *
     * The id is assigned at spawn/adopt time and never changes, so it's
     * the right key for the `/sessions/by-id/:id` route family introduced
     * in MC1e PR2. Linear scan is fine at the MAX_SESSIONS=20 ceiling;
     * indexing by id would add a second Map to keep in sync for no
     * observable benefit.
     *
     * @param {string} id
     * @returns {Session|undefined}
     */
    getSessionById(id) {
      if (!id || typeof id !== "string") return undefined;
      for (const session of sessions.values()) {
        if (session.id === id) return session;
      }
      return undefined;
    },

    /**
     * Look up a session by its tmux pane id (`%N`).
     *
     * Used by the Claude hook ingest handler to resolve payloads stamped
     * with `_tmuxPane` back to a known katulong session. The pane id is
     * captured once at spawn/adopt time (see `tmuxGetPaneId`) so the lookup
     * is authoritative — we do not trust the hook payload itself.
     *
     * @param {string} pane - tmux pane id (e.g. "%3")
     * @returns {Session|undefined}
     */
    getSessionByPane(pane) {
      if (!pane || typeof pane !== "string" || !/^%\d+$/.test(pane)) return undefined;
      for (const session of sessions.values()) {
        if (session.tmuxPane === pane) return session;
      }
      return undefined;
    },

    /**
     * Restore sessions from sessions.json, re-adopting tmux sessions that still exist.
     *
     * Accepts both persistence formats:
     *   - legacy: `{ [name]: tmuxName }` (string value)
     *   - current: `{ [name]: { tmuxName, id, tmuxPane } }` (object value)
     *
     * A legacy entry is restored with a fresh id — there is no stable id
     * in the old format to recover. `tmuxPane` is recaptured live by
     * `adoptSession()` regardless of what was persisted, so a stale or
     * missing value on disk is harmless. The next scheduleSave() rewrites
     * the file in the current shape.
     */
    async restoreSessions() {
      const map = store.load();
      if (!map) return;

      // Normalize to `{ friendlyName, tmuxName, id }`. Filter candidates
      // synchronously, then restore in parallel.
      const candidates = [];
      for (const [friendlyName, entry] of Object.entries(map)) {
        let tmuxName = null;
        let persistedId = null;
        let persistedMeta = null;
        if (typeof entry === "string") {
          tmuxName = entry;
        } else if (entry && typeof entry === "object" && typeof entry.tmuxName === "string") {
          tmuxName = entry.tmuxName;
          if (typeof entry.id === "string" && SESSION_ID_PATTERN.test(entry.id)) {
            persistedId = entry.id;
          }
          if (entry.meta && typeof entry.meta === "object" && !Array.isArray(entry.meta)) {
            // Re-strip transient claude fields defensively — older files
            // may carry `running`/`detectedAt` from before we filtered them
            // on write, and those are always re-derived by the child-count
            // monitor.
            persistedMeta = persistableMeta(entry.meta);
          }
        }
        if (!tmuxName) continue;
        if (sessions.has(friendlyName)) continue;
        if (isAlreadyManaged(tmuxName)) continue;
        candidates.push({ friendlyName, tmuxName, persistedId, persistedMeta });
      }

      await Promise.allSettled(
        candidates.map(async ({ friendlyName, tmuxName, persistedId, persistedMeta }) => {
          const exists = await tmuxHasSession(tmuxName);
          if (!exists) return;
          const session = await adoptSession(friendlyName, tmuxName, DEFAULT_COLS, DEFAULT_ROWS, { id: persistedId, meta: persistedMeta });
          sessions.set(friendlyName, session);
          log.info("Restored session", { session: friendlyName, tmux: tmuxName });
        })
      ).then(results => {
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "rejected") {
            log.warn("Failed to restore session", { session: candidates[i].friendlyName, error: results[i].reason?.message });
          }
        }
      });

      // Note: we intentionally do NOT resize restored sessions to DEFAULT_COLS.
      // Column width is now variable — each client calculates its own cols
      // from viewport width and sends them via attach/resize. Forcing a
      // resize here would override the last client's negotiated dimensions.

      // Auto-adopt any tmux sessions not covered by sessions.json.
      // This makes tmux the source of truth — if a session exists in tmux
      // but isn't tracked by katulong, adopt it automatically so it appears
      // in the UI. Handles the case where sessions.json is empty/stale
      // after an update or crash.
      const SAFE_NAME = /^[A-Za-z0-9_\-]+$/;
      const tmuxSessions = await tmuxListSessions();
      const orphans = tmuxSessions.filter(name =>
        !isAlreadyManaged(name) && SAFE_NAME.test(name) && name.length <= 128
      );
      if (orphans.length > 0) {
        log.info("Auto-adopting unmanaged tmux sessions", { count: orphans.length, tmuxNames: orphans });
        // Serial loop so aliveSessionCount() is accurate per-iteration
        for (const tmuxName of orphans) {
          if (aliveSessionCount() >= MAX_SESSIONS) {
            log.warn("Max sessions reached, skipping remaining orphans", { tmuxName });
            break;
          }
          try {
            const session = await adoptSession(tmuxName, tmuxName, DEFAULT_COLS, DEFAULT_ROWS, { external: true });
            // Re-check after async work (guards against concurrent adopt race)
            if (isAlreadyManaged(tmuxName)) {
              session.detach();
              continue;
            }
            sessions.set(tmuxName, session);
            log.info("Auto-adopted tmux session", { tmuxName });
          } catch (err) {
            log.warn("Failed to auto-adopt tmux session", { tmuxName, error: err.message });
          }
        }
        scheduleSave();
      }

      // Always rewrite sessions.json after restore. If any legacy
      // string-valued entries were loaded, they were restored with fresh
      // ids — persisting now seals those ids into the file so subsequent
      // restarts keep them stable. No-op when the shape is already current.
      scheduleSave();
    },

    /**
     * Shutdown: close control mode processes but leave tmux sessions alive.
     */
    shutdown() {
      childCountMonitor.stop();
      outputCoalescer.shutdown();
      for (const t of idleCheckTimers.values()) clearTimeout(t);
      idleCheckTimers.clear();
      // Flush any pending debounced save and write final state
      store.cancelPendingSave();
      store.saveNow();
      for (const [, session] of sessions) {
        session.detach();
      }
    },
  };
}

export { checkTmux, cleanTmuxServerEnv, setTmuxKatulongEnv };
