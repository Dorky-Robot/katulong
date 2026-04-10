import { spawn } from "node:child_process";
import { log } from "./log.js";
import { RingBuffer } from "./ring-buffer.js";
import { ScreenState } from "./screen-state.js";
import { createTmuxOutputParser } from "./tmux-output-parser.js";
import {
  encodeHexKeys,
  stripDaResponses, tmuxKillSession, tmuxSocketArgs,
} from "./tmux.js";

// tmux's yacc parser overflows at ~9997 arguments to send-keys -H.
// Chunk large input to stay safely under that limit.
const SEND_KEYS_MAX_BYTES = 4096;

// Resize gate: defer SIGWINCH when output is actively flowing.
// The client-side terminal-pool.js applies an 80ms upstream debounce;
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
 * Session - Domain model for terminal sessions managed by tmux.
 *
 * Uses tmux control mode (`tmux -u -C attach-session -d -t <name>`) for I/O.
 * stdin carries tmux commands (send-keys, refresh-client) and stdout carries
 * %output protocol lines with terminal data.
 */
export class Session {
  /**
   * Create a new Session backed by tmux control mode.
   * @param {string} name - Session name
   * @param {string} tmuxName - Sanitized tmux session name
   * @param {object} options
   * @param {number} [options.maxBufferItems]
   * @param {number} [options.maxBufferBytes]
   * @param {Function} [options.onData] - Callback: onData(sessionName, fromSeq)
   * @param {Function} [options.onExit] - Callback for session exit
   * @param {Function} [options._spawn] - Test-only: child_process.spawn replacement
   *   used by unit tests to avoid spawning a real tmux binary.
   * @param {Function} [options._tmuxKillSession] - Test-only: tmuxKillSession
   *   replacement used by unit tests to observe the exact ordering of the
   *   detach-then-kill-session sequence in kill().
   */
  // Session lifecycle states
  static STATE_ATTACHED = "attached";
  static STATE_DETACHED = "detached";
  static STATE_KILLED = "killed";

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
      maxBufferBytes = 20 * 1024 * 1024,
      external = false,
      onData,
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

    this.outputBuffer = new RingBuffer(maxBufferBytes);
    this._onData = onData;
    this._onExit = onExit;

    // Server-side mirror of the visible screen — used to serialize terminal
    // state (cursor + cell contents + styles) for clients on attach/switch
    // and to compute drift-detection fingerprints. See lib/screen-state.js.
    this._screen = new ScreenState();

    // tmux control-mode output parser — owns all the line buffering, UTF-8
    // decoding, and octal-escape carry state. Callback is wired here so
    // every %output payload flows through the same "push to RingBuffer +
    // screen + fire onData" sequence. See lib/tmux-output-parser.js for
    // the parser contract.
    this._parser = createTmuxOutputParser({
      onData: (payload) => this._handleOutputPayload(payload),
    });
  }

  get alive() {
    return this.state === Session.STATE_ATTACHED;
  }

  /**
   * Handle a single decoded %output payload from the tmux parser.
   *
   * The parser owns all the line-buffering and UTF-8 decoding state; by the
   * time we get here, `payload` is a clean UTF-8 string ready to append to
   * the RingBuffer, mirror into the screen, and relay to subscribers.
   *
   * @private
   */
  _handleOutputPayload(payload) {
    this._lastOutputAt = Date.now();
    const fromSeq = this.outputBuffer.totalBytes;
    this.outputBuffer.push(payload);
    this._screen.write(payload);
    if (this._onData) {
      this._onData(this.name, fromSeq);
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
   *
   * Large input is chunked because tmux's yacc command parser overflows
   * at ~9997 arguments.  Each byte becomes one hex-pair argument, so we
   * split at SEND_KEYS_MAX_BYTES (4096) to stay well under the limit.
   *
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

    const buf = Buffer.from(filtered);
    for (let off = 0; off < buf.length; off += SEND_KEYS_MAX_BYTES) {
      const chunk = buf.subarray(off, off + SEND_KEYS_MAX_BYTES);
      const hex = encodeHexKeys(chunk);
      if (hex) {
        this._sendControlCmd(`send-keys -H ${hex}`);
      }
    }
  }

  /**
   * Resize the terminal via tmux control mode.
   * @param {number} cols
   * @param {number} rows
   * @param {object} [opts]
   * @param {boolean} [opts.force=false] - Bypass the output-idle gate. Use
   *   for explicit lifecycle events (client attach, active-client promotion)
   *   where the snapshot dims must match the consumer's render dims. The
   *   gate exists to absorb continuous SIGWINCH from drag/keystroke, not
   *   discrete one-shot events; deferring those past `snapshot()` lets
   *   the headless serialize at stale dims and garbles absolute cursor
   *   positioning on the client (regression of 38a62b6).
   */
  resize(cols, rows, opts = {}) {
    if (this.state !== Session.STATE_ATTACHED) return;
    // Skip if dimensions haven't changed — avoids unnecessary SIGWINCH
    // that can garble TUI apps (Claude Code, vim, htop) mid-render.
    if (this._screen.cols === cols && this._screen.rows === rows) return;

    if (opts.force) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
      this._resizeDeadline = 0;
      this._applyResize(cols, rows);
      return;
    }

    // Gate resize behind output-idle check.  TUI apps like Claude Code
    // do full-screen redraws using cursor positioning.  A SIGWINCH that
    // arrives mid-render interrupts the draw, causing partial escape
    // sequences from the old dimensions to interleave with the new
    // redraw — producing garbled, overlapping text.
    //
    // If output was received within the last RESIZE_IDLE_GATE_MS, defer
    // the resize until output settles.  The deferred timer re-enters
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
        this._applyResize(cols, rows);
        return;
      }
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        this.resize(cols, rows);
      }, RESIZE_IDLE_GATE_MS - sinceLast);
      return;
    }

    this._resizeDeadline = 0;
    this._applyResize(cols, rows);
  }

  /** @private Apply the resize immediately. */
  _applyResize(cols, rows) {
    if (this.state !== Session.STATE_ATTACHED) return;
    // Guard for deferred-timer path: session may have died or already
    // been resized to these dimensions while the timer was pending.
    if (this._screen.cols === cols && this._screen.rows === rows) return;
    // Tell tmux control mode client about the new size.
    // With window-size=latest, tmux resizes the pane to match.
    // This is processed synchronously on the control mode stdin,
    // so the resize takes effect before any subsequent %output —
    // unlike resize-window (async exec) which races with output
    // and also resets window-size to "manual", breaking future
    // refresh-client resizes.
    this._sendControlCmd(`refresh-client -C ${cols}x${rows}`);
    this._screen.resize(cols, rows);
  }

  /**
   * Seed the screen mirror with captured pane content (server-restart path).
   * Delegates to ScreenState — see lib/screen-state.js for the rationale.
   * The seed data is NOT pushed to the RingBuffer.
   *
   * @param {string|null} content - Captured pane text (with ANSI escapes)
   * @param {{ row: number, col: number }|null} [cursorPos] - 1-based cursor position
   */
  async seedScreen(content, cursorPos = null) {
    return this._screen.seed(content, cursorPos);
  }

  /**
   * Serialize the visible screen state to escape sequences for client replay.
   * Returns "" on disposal or any internal error so callers (attach,
   * subscribe, resync) never throw mid-snapshot.
   */
  async serializeScreen() {
    try {
      return await this._screen.serialize();
    } catch (err) {
      log.warn("Failed to serialize headless terminal", { session: this.name, error: err.message });
      return "";
    }
  }

  /**
   * Compute a fingerprint of the visible terminal screen for drift detection.
   *
   * Returns `{ hash, seq }` where:
   *   - `hash` is the DJB2 fingerprint computed by ScreenState — the same
   *     algorithm runs on the client (public/lib/screen-fingerprint.js)
   *   - `seq` is the byte position the hash describes
   *
   * Pairing them prevents a Lamport-style ordering bug: the client must
   * compare its state against the server's hash AT THE SAME POINT in the
   * stream. Without seq, a client one frame behind would report false drift
   * and trigger a spurious resync. See PR #520.
   *
   * `seq` is captured AFTER the flush await but BEFORE computing the hash:
   * after the await, anything that was pending in the headless write queue
   * has been processed, and `outputBuffer.totalBytes` reflects every byte
   * that has been pushed (the parser writes to outputBuffer and the screen
   * in the same synchronous block, so they cannot disagree mid-await).
   *
   * Wrapped in try/catch because `scheduleIdleCheck` in session-manager
   * calls this from a setTimeout where unhandled rejections have no catcher.
   * The flush() guard inside ScreenState handles the killed-mid-await case.
   */
  async screenFingerprint() {
    try {
      const ready = await this._screen.flush();
      if (!ready) return { hash: 0, seq: 0 };
      const seq = this.outputBuffer.totalBytes;
      return { hash: this._screen.computeHash(), seq };
    } catch (err) {
      log.warn("Failed to compute screen fingerprint", { session: this.name, error: err.message });
      return { hash: 0, seq: 0 };
    }
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
   * Current byte position in the output stream.
   *
   * Equal to the total bytes ever pushed into the RingBuffer (NOT the
   * RingBuffer's residual size — eviction does not roll this back). This
   * is the value clients use as their `seq` cursor when pulling buffered
   * output: pulling from `cursor` returns nothing (no new bytes), pulling
   * from `cursor - N` returns the last N bytes, etc.
   *
   * Exposed as a getter so callers (session-manager attach/subscribe,
   * websocket bridge) don't need to reach into `outputBuffer.totalBytes`.
   */
  get cursor() {
    return this.outputBuffer.totalBytes;
  }

  /**
   * Take a Lamport-correct snapshot of the visible screen for client replay.
   *
   * Returns `{ buffer, seq, alive }` where:
   *   - `buffer` is the escape-sequence serialization of the screen mirror
   *   - `seq` is the byte position in the output stream the buffer reflects
   *   - `alive` is whether the session is still attached
   *
   * Clients use the result to render the snapshot and then pull from `seq`
   * onward. The flush-then-serialize order ensures `buffer` and `seq`
   * describe the same Lamport instant — without it, a client one frame
   * behind would render a stale snapshot, then start pulling from a future
   * cursor and miss the bytes in between.
   *
   * Errors are caught and turned into an empty buffer rather than thrown,
   * so callers (attachClient, subscribeClient, resync) never crash on a
   * mid-snapshot disposal.
   */
  async snapshot() {
    if (!this.alive) {
      return { buffer: "", seq: this.cursor, alive: false };
    }
    let buffer = "";
    try {
      buffer = await this._screen.serialize();
    } catch (err) {
      log.warn("Failed to snapshot session", { session: this.name, error: err.message });
    }
    // seq is read AFTER serialize so it matches the bytes baked into the
    // returned buffer (synchronous code between the await and this read
    // can't see new %output — Node only fires I/O on tick boundaries).
    return { buffer, seq: this.cursor, alive: this.alive };
  }

  /**
   * Pull buffered output starting from the given byte position.
   *
   * Returns `{ data, cursor }` where `data` is the escape-sequence string
   * from `fromSeq` to the current cursor, and `cursor` is the byte position
   * the data ends at (clients advance their seq to this value). Returns
   * `{ data: "", cursor }` when there's nothing new.
   */
  pullFrom(fromSeq) {
    const cursor = this.cursor;
    const data = this.outputBuffer.sliceFrom(fromSeq);
    return { data, cursor };
  }

  /**
   * Pull the last `maxBytes` of buffered output, clamped to what the
   * RingBuffer still holds.
   *
   * Encapsulates the `Math.max(cursor - maxBytes, ringBufferStartOffset)`
   * arithmetic so route handlers never reach into `outputBuffer` internals.
   * Returns `{ data, cursor }` shaped like `pullFrom`.
   */
  pullTail(maxBytes) {
    const cursor = this.cursor;
    const desired = cursor - maxBytes;
    const startOffset = this.outputBuffer.getStartOffset();
    const fromSeq = desired > startOffset ? desired : startOffset;
    const data = this.outputBuffer.sliceFrom(fromSeq) || "";
    return { data, cursor };
  }

  /**
   * Get the buffered output as a string.
   * @returns {string}
   */
  getBuffer() {
    return this.outputBuffer.toString();
  }

  /**
   * Clear the output buffer.
   */
  clearBuffer() {
    this.outputBuffer.clear();
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
      buffer: this.outputBuffer.stats(),
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
