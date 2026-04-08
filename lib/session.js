import { spawn } from "node:child_process";
import { log } from "./log.js";
import { ScreenState } from "./screen-state.js";
import { createTmuxOutputParser } from "./tmux-output-parser.js";
import {
  encodeHexKeys,
  stripDaResponses, tmuxKillSession, tmuxSocketArgs,
} from "./tmux.js";

// Resize gate: defer SIGWINCH when output is actively flowing.
// The client-side terminal-pool applies an 80ms upstream debounce;
// this server-side gate adds a second layer at the tmux control mode
// boundary so resize doesn't interrupt TUI apps mid-render.
const RESIZE_IDLE_GATE_MS = 50;
// Maximum total deferral for resize — prevents starving resize on
// never-idle sessions (e.g., `tail -f` or continuous TUI rendering).
const RESIZE_MAX_DEFER_MS = 500;

// --- Session class ---

export class SessionNotAliveError extends Error {
  constructor(sessionName) {
    super(`Cannot perform operation on dead session: ${sessionName}`);
    this.name = "SessionNotAliveError";
    this.sessionName = sessionName;
  }
}

/**
 * Session — Domain model for terminal sessions managed by tmux.
 *
 * Uses tmux control mode (`tmux -u -C attach-session -d -t <name>`) for I/O.
 * stdin carries tmux commands (send-keys, refresh-client) and stdout carries
 * %output protocol lines with terminal data.
 *
 * Raptor 3 streaming model
 * ------------------------
 * Sessions no longer own a RingBuffer of raw bytes or expose pull/replay.
 * The only persistent state is the ScreenState headless mirror — that is
 * the single source of truth for "what the terminal looks like right now".
 *
 * Output flows through two callbacks:
 *
 *   - `onData(name, payload)` fires on every decoded %output payload.
 *     Session-manager pushes the bytes into its output coalescer, which
 *     debounces and then relays them as an `output` message to all
 *     clients viewing the session. Bytes are written into ScreenState
 *     at the current PTY dims before the callback fires, so the
 *     serialized snapshot on the next resize/attach reflects them.
 *
 *   - `onSnapshot({ session, cols, rows, data })` fires after every
 *     server-side resize, once ScreenState has been resized and
 *     re-serialized. It is the atomic "clients must transition to
 *     these dims now" message. Session-manager flushes the coalescer
 *     BEFORE calling _applyResize so that any pending old-dim bytes
 *     reach old-dim clients first; the snapshot is then emitted with
 *     the new dims and the new serialized content.
 *
 * The resize → snapshot path is the only way dims ever change. Clients
 * never call `term.resize()` locally — they just apply what the server
 * tells them. See docs/raptor3-streaming.md for the full rationale and
 * the garble failure modes this architecture closes off.
 */
export class Session {
  // Session lifecycle states
  static STATE_ATTACHED = "attached";
  static STATE_DETACHED = "detached";
  static STATE_KILLED = "killed";

  /**
   * Create a new Session backed by tmux control mode.
   *
   * @param {string} name - Session name
   * @param {string} tmuxName - Sanitized tmux session name
   * @param {object} options
   * @param {boolean} [options.external] - True if the tmux session was
   *   adopted from an existing tmux server (vs. spawned by katulong).
   * @param {(name: string, payload: string) => void} [options.onData]
   *   Fires on every decoded %output payload with the raw bytes.
   * @param {(event: { session: string, cols: number, rows: number, data: string }) => void} [options.onSnapshot]
   *   Fires after every server-side resize with the new dims and the
   *   serialized ScreenState. Session-manager flushes pending output
   *   BEFORE the resize runs, so the snapshot is ordered-after old-dim
   *   output and ordered-before new-dim output.
   * @param {(name: string, exitCode: number) => void} [options.onExit]
   *   Fires when the tmux process exits for any reason.
   * @param {Function} [options._spawn] - Test-only: child_process.spawn replacement
   * @param {Function} [options._tmuxKillSession] - Test-only: tmuxKillSession replacement
   */
  constructor(name, tmuxName, options = {}) {
    this.name = name;
    this.tmuxName = tmuxName;
    this.state = Session.STATE_DETACHED;
    this.controlProc = null;
    this._childCount = 0;
    // Initialize to "recent" so the first resize after construction is gated
    // by the same idle check as later resizes. With 0 (the prior default),
    // the very first call saw sinceLast ≈ Date.now() which is always huge,
    // so it raced any in-flight startup output (shell prompt, terminal init
    // escapes) and could fire `refresh-client -C` mid-burst.
    this._lastOutputAt = Date.now();
    this._resizeTimer = null;   // pending resize gate timer
    this._resizeDeadline = 0;   // max deferral cap for resize gate (absolute)

    const {
      external = false,
      onData,
      onSnapshot,
      onExit,
      // Injectable for tests — lets us attach without spawning real tmux.
      _spawn = spawn,
      // Injectable for tests — lets the kill() regression test verify that
      // `tmux kill-session` only runs AFTER the control client has closed.
      _tmuxKillSession = tmuxKillSession,
    } = options;

    this.external = external;
    this.icon = null; // per-session icon override (Phosphor icon name)
    this._spawn = _spawn;
    this._tmuxKillSession = _tmuxKillSession;

    this._onData = onData;
    this._onSnapshot = onSnapshot;
    this._onExit = onExit;

    // Server-side mirror of the visible screen. The single source of truth
    // for "what the terminal looks like right now". Serialized on every
    // attach/switch/resize and sent to clients as the authoritative state.
    this._screen = new ScreenState();

    // tmux control-mode output parser — owns all the line buffering, UTF-8
    // decoding, and octal-escape carry state. Callback is wired here so
    // every %output payload flows through the same "mirror to screen +
    // push to coalescer" sequence. See lib/tmux-output-parser.js for
    // the parser contract.
    this._parser = createTmuxOutputParser({
      onData: (payload) => this._handleOutputPayload(payload),
    });
  }

  get alive() {
    return this.state === Session.STATE_ATTACHED;
  }

  /** Current dims of the ScreenState mirror (authoritative for resize). */
  get cols() { return this._screen.cols; }
  get rows() { return this._screen.rows; }

  /**
   * Handle a single decoded %output payload from the tmux parser.
   *
   * The parser owns all the line-buffering and UTF-8 decoding state; by the
   * time we get here, `payload` is a clean UTF-8 string ready to mirror
   * into the screen and relay to subscribers.
   *
   * @private
   */
  _handleOutputPayload(payload) {
    this._lastOutputAt = Date.now();
    this._screen.write(payload);
    if (this._onData) {
      this._onData(this.name, payload);
    }
  }

  /**
   * Attach to the tmux session via control mode.
   * Spawns `tmux -u -C attach-session -d -t <name>` as a child process.
   */
  attachControlMode(cols, rows) {
    // Clear any residual parser state from a prior attach before we start
    // streaming bytes from the new tmux process. Must happen before the
    // stdout handler is wired up.
    this._parser.reset();

    // socket isolation: see tmuxSocketArgs() in lib/tmux.js
    const args = [...tmuxSocketArgs(), "-u", "-C", "attach-session", "-d", "-t", this.tmuxName];
    const proc = this._spawn("tmux", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.controlProc = proc;

    // Mark as attached immediately after spawn — before registering event
    // handlers so that close/error events (which can fire on the next tick
    // if tmux exits immediately) see the correct state and call onExit.
    this.state = Session.STATE_ATTACHED;

    // Set initial terminal size
    this._sendControlCmd(`refresh-client -C ${cols}x${rows}`);
    this._screen.resize(cols, rows);

    proc.stdout.on("data", (chunk) => this._parser.write(chunk));

    // Close/error handlers capture `proc` in the closure. If the session
    // is reattached before this process's close event fires, the parser
    // state will have been reset by `_parser.reset()` for the new attach
    // — draining here would prematurely flush the NEW parser and drop
    // buffered UTF-8 bytes on the live stream. Guard with a
    // `this.controlProc !== proc` check so stale events on a superseded
    // process become no-ops.
    proc.on("close", (code) => {
      if (this.controlProc !== proc) return;
      // Unexpected-close path: tmux exited without going through
      // _closeControlProc (e.g. crashed). Drain the parser here so the
      // trailing UTF-8 sequence isn't lost.
      this._parser.drain();
      if (this.state === Session.STATE_ATTACHED) {
        this.state = Session.STATE_DETACHED;
        if (this._onExit) {
          this._onExit(this.name, code ?? 0);
        }
      }
    });

    proc.on("error", (err) => {
      if (this.controlProc !== proc) return;
      if (this.state === Session.STATE_ATTACHED) {
        this.state = Session.STATE_DETACHED;
        if (this._onExit) {
          this._onExit(this.name, 1);
        }
      }
    });
  }

  /**
   * Send a command to the tmux control mode stdin.
   * @private
   */
  _sendControlCmd(cmd) {
    if (this.controlProc && this.controlProc.stdin.writable) {
      this.controlProc.stdin.write(cmd + "\n");
    }
  }

  /**
   * Write data to the session via tmux send-keys.
   * @param {string} data
   * @throws {SessionNotAliveError}
   */
  write(data) {
    if (this.state !== Session.STATE_ATTACHED) {
      throw new SessionNotAliveError(this.name);
    }
    // Strip DA responses that xterm.js echoes back
    const filtered = stripDaResponses(data);
    if (!filtered) return;

    const hex = encodeHexKeys(filtered);
    if (hex) {
      this._sendControlCmd(`send-keys -H ${hex}`);
    }
  }

  /**
   * Resize the terminal via tmux control mode.
   *
   * Returns a Promise that resolves once the onSnapshot callback has
   * fired (immediate path) or the deferred timer has been scheduled
   * (idle-gate path). Production callers generally fire-and-forget;
   * the promise is exposed so tests can await resize completion
   * without polling.
   *
   * @param {number} cols
   * @param {number} rows
   * @returns {Promise<void>}
   */
  resize(cols, rows) {
    if (this.state !== Session.STATE_ATTACHED) return Promise.resolve();
    // Skip if dimensions haven't changed — avoids unnecessary SIGWINCH
    // that can garble TUI apps (Claude Code, vim, htop) mid-render.
    if (this._screen.cols === cols && this._screen.rows === rows) return Promise.resolve();

    // Gate resize behind output-idle check. TUI apps like Claude Code do
    // full-screen redraws using cursor positioning. A SIGWINCH that arrives
    // mid-render interrupts the draw, causing partial escape sequences
    // from the old dimensions to interleave with the new redraw —
    // producing garbled, overlapping text.
    //
    // If output was received within the last RESIZE_IDLE_GATE_MS, defer
    // the resize until output settles. The deferred timer re-enters
    // resize() to re-check idleness, so continuous output keeps deferring.
    // Total deferral is capped at RESIZE_MAX_DEFER_MS to avoid starving
    // resize on never-idle sessions (e.g., `tail -f`).
    const now = Date.now();
    const sinceLast = now - this._lastOutputAt;
    if (sinceLast < RESIZE_IDLE_GATE_MS) {
      // Set deadline on the first deferral in this chain only. Guarding on
      // `_resizeTimer` (the prior behavior) was wrong: the recursive timer
      // callback nulls `_resizeTimer` before re-entering, so every re-entry
      // saw the guard as true and reset the deadline. The cap was supposed
      // to be absolute but became a sliding window that never expired —
      // continuous output (`tail -f`, TUI redraws) deferred resize forever.
      if (!this._resizeDeadline) {
        this._resizeDeadline = now + RESIZE_MAX_DEFER_MS;
      }
      // If we've exceeded the max deferral, apply immediately
      if (now >= this._resizeDeadline) {
        this._resizeDeadline = 0;
        return this._applyResize(cols, rows);
      }
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        this.resize(cols, rows);
      }, RESIZE_IDLE_GATE_MS - sinceLast);
      return Promise.resolve();
    }

    this._resizeDeadline = 0;
    return this._applyResize(cols, rows);
  }

  /**
   * Apply the resize immediately and emit a snapshot.
   *
   * Raptor 3 ordering: callers (session-manager) flush any pending
   * output in the coalescer BEFORE invoking resize, so the old-dim
   * bytes reach old-dim clients first. This function then:
   *
   *   1. Writes `refresh-client -C` to tmux stdin (synchronous).
   *      tmux reflows the pane and will emit new-dim bytes shortly
   *      after — these arrive on stdout asynchronously.
   *   2. Resizes ScreenState in lockstep BEFORE awaiting serialize,
   *      so any tmux bytes that land during the flush wait are written
   *      into the new-dim buffer.
   *   3. Awaits `this._screen.serialize()` — this drains xterm's
   *      internal write queue (via setTimeout, not a microtask) and
   *      returns the serialized content at the new dims. Fresh
   *      %output may arrive during this await; those bytes are
   *      written into ScreenState at new dims and also flow through
   *      onData → coalescer at new dims.
   *   4. Fires `onSnapshot` with the new dims and the serialized
   *      content. Session-manager relays this via the bridge;
   *      clients apply `term.resize → term.clear → term.write(data)`
   *      atomically.
   *
   * Because ScreenState is resized before the await, every byte that
   * enters after refresh-client — whether it lands in the snapshot
   * data or arrives later via the output coalescer — is at new dims.
   * The client transitions to new dims via the snapshot, then appends
   * any subsequent new-dim output normally. No dim mismatch, no garble.
   *
   * @private
   */
  async _applyResize(cols, rows) {
    if (this.state !== Session.STATE_ATTACHED) return;
    // Guard for deferred-timer path: session may have died or already
    // been resized to these dimensions while the timer was pending.
    if (this._screen.cols === cols && this._screen.rows === rows) return;
    // With window-size=latest, tmux resizes the pane to match.
    // This is processed synchronously on the control mode stdin,
    // so the resize takes effect before any subsequent %output.
    this._sendControlCmd(`refresh-client -C ${cols}x${rows}`);
    this._screen.resize(cols, rows);

    // Serialize-and-emit the snapshot. Errors become an empty-data snapshot
    // so clients still transition to new dims; the next output burst will
    // repaint the content.
    let data = "";
    try {
      data = await this._screen.serialize();
    } catch (err) {
      log.warn("Failed to serialize screen after resize", { session: this.name, error: err.message });
    }
    if (this._onSnapshot) {
      this._onSnapshot({ session: this.name, cols, rows, data });
    }
  }

  /**
   * Seed the screen mirror with captured pane content (server-restart path).
   * Delegates to ScreenState — see lib/screen-state.js for the rationale.
   *
   * @param {string|null} content - Captured pane text (with ANSI escapes)
   * @param {{ row: number, col: number }|null} [cursorPos] - 1-based cursor position
   */
  async seedScreen(content, cursorPos = null) {
    return this._screen.seed(content, cursorPos);
  }

  /**
   * Take a snapshot of the visible screen for client delivery.
   *
   * Returns `{ cols, rows, data, alive }` — the current ScreenState
   * dimensions and a serialized representation of the visible screen.
   * Used by the attach and subscribe paths to seed the client's xterm.
   *
   * Errors are caught and turned into an empty-data snapshot so callers
   * never crash on a mid-snapshot disposal. An empty data string is a
   * valid "show a blank screen at these dims" state.
   */
  async snapshot() {
    if (!this.alive) {
      return { cols: this._screen.cols, rows: this._screen.rows, data: "", alive: false };
    }
    let data = "";
    try {
      data = await this._screen.serialize();
    } catch (err) {
      log.warn("Failed to snapshot session", { session: this.name, error: err.message });
    }
    return { cols: this._screen.cols, rows: this._screen.rows, data, alive: this.alive };
  }

  /**
   * Close the control mode process without killing the tmux session.
   *
   * Uses an in-band `detach-client` command so the tmux server tears
   * the control client down via its normal detach path instead of the
   * abrupt-close path. See the commit message for fix/tmux-control-detach-crash
   * for the full rationale — short version: on tmux 3.6a, sending
   * SIGTERM (or any other abrupt close) to a `tmux -C` child races
   * a use-after-free in `control_notify_client_detached` →
   * `control_write` and segfaults the server process, producing the
   * "server exited unexpectedly" symptom and tmux-*.ips crash reports.
   *
   * @param {Function} [onClose] - Optional callback fired after the
   *   control client has fully exited (or immediately if there was
   *   no live child). `kill()` uses this to run `tmux kill-session`
   *   AFTER the control client is gone, because destroying a session
   *   while a control client is still attached trips the same UAF.
   * @private
   */
  _closeControlProc(onClose) {
    // Drain any partial bytes still in the parser BEFORE clearing _onData
    // and disposing the headless. Without this, the trailing character
    // of any mid-UTF-8 sequence buffered in the payload decoder is
    // silently dropped on every detach/kill (the close-handler fallback
    // below does not run because we null `this.controlProc` here, and
    // its guard returns).
    this._parser.drain();
    // Prevent stale callbacks from relaying output after close
    this._onData = null;
    this._onSnapshot = null;
    clearTimeout(this._resizeTimer);
    this._resizeTimer = null;
    this._screen.dispose();

    const proc = this.controlProc;
    this.controlProc = null;

    if (!proc) {
      if (onClose) onClose();
      return;
    }

    // `killTimer` is assigned below, AFTER the once() handlers register.
    // In Node.js event emission is always async, so the close handler can
    // never fire before the synchronous setTimeout() call that assigns
    // killTimer; but even if it did, clearTimeout(null) is a documented
    // no-op so complete() stays safe either way.
    let killTimer = null;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      if (killTimer) clearTimeout(killTimer);
      if (onClose) onClose();
    };
    proc.once("close", complete);
    proc.once("error", complete);

    try {
      if (proc.stdin.writable) {
        // In-band detach: tmux control mode treats `detach-client`
        // as a regular command. tmux responds with %begin/%end and
        // exits cleanly, walking the server's normal detach
        // teardown rather than the crash-prone abrupt-close path.
        // TODO: remove this workaround once tmux ships a release >
        // 3.6a with the fix for the control_notify_client_detached
        // → control_write use-after-free.
        proc.stdin.write("detach-client\n");
        proc.stdin.end();
      }
    } catch { /* already dead */ }

    // Watchdog: if tmux doesn't honor detach-client within 2s (hung
    // process, half-dead server, etc.) force SIGKILL so we don't
    // leak the child. 2s is enough for a healthy tmux to process
    // the command — detach-client is a single imsg round-trip.
    // unref() so the watchdog doesn't keep the Node process alive
    // during normal shutdown; we don't need to wait for it to fire
    // if nothing else is running.
    killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    }, 2000);
    if (typeof killTimer.unref === "function") killTimer.unref();
  }

  /**
   * Detach from the tmux session (close control mode only, leave tmux session alive).
   */
  detach() {
    if (this.state !== Session.STATE_ATTACHED) return;
    this.state = Session.STATE_DETACHED;
    this._closeControlProc();
  }

  /**
   * Kill the tmux session and control mode process.
   * Works on both attached and detached sessions.
   *
   * Order matters: detach the control client FIRST, then destroy
   * the session. Running `tmux kill-session` while a control
   * client is still attached trips the same UAF crash in tmux 3.6a
   * as the abrupt-close path — the session-destroy notification
   * walks freed control-client state.
   *
   * `kill()` is fire-and-forget: it marks the session as KILLED
   * synchronously (so `alive` is immediately false) but the actual
   * `tmux kill-session` call runs asynchronously from the control
   * client's close handler. Callers that immediately re-use the
   * same `tmuxName` (e.g. spawn-after-kill with a name collision)
   * must not race against this — either poll `tmuxHasSession` from
   * `lib/tmux.js` until the old session is gone, or pick a fresh
   * name.
   */
  kill() {
    if (this.state === Session.STATE_KILLED) return;
    this.state = Session.STATE_KILLED;
    this._closeControlProc(() => {
      this._tmuxKillSession(this.tmuxName).catch(err => {
        log.debug("tmux kill-session failed (may already be dead)", { session: this.name, error: err.message });
      });
    });
  }

  /**
   * Update the known child process count.
   * @param {number} count
   */
  updateChildCount(count) {
    this._childCount = count;
  }

  /**
   * Check if the session has running child processes.
   * @returns {boolean}
   */
  hasChildProcesses() {
    if (!this.alive) return false;
    return this._childCount > 1;
  }

  /**
   * Get session statistics.
   * @returns {object}
   */
  stats() {
    return {
      name: this.name,
      tmuxSession: this.tmuxName,
      alive: this.alive,
      cols: this._screen.cols,
      rows: this._screen.rows,
    };
  }

  /**
   * Set the per-session tab icon (Phosphor icon name, e.g. "cube").
   * Pass null/empty to clear the override and use the instance icon.
   * @param {string|null} iconName
   */
  setIcon(iconName) {
    if (!iconName || typeof iconName !== "string") {
      this.icon = null;
      return;
    }
    // Sanitize: lowercase, digits, hyphens only, max 50 chars
    const sanitized = iconName.replace(/[^a-z0-9-]/g, "").slice(0, 50);
    this.icon = sanitized || null;
  }

  /**
   * Serialize to JSON for API responses.
   * @returns {object}
   */
  toJSON() {
    return {
      name: this.name,
      tmuxSession: this.tmuxName,
      alive: this.alive,
      hasChildProcesses: this.hasChildProcesses(),
      external: this.external,
      icon: this.icon,
    };
  }
}
