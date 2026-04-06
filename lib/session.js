import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import xtermHeadless from "@xterm/headless";
import xtermSerialize from "@xterm/addon-serialize";
const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;
import { log } from "./log.js";
import { RingBuffer } from "./ring-buffer.js";
import { DEFAULT_COLS, TERMINAL_ROWS_DEFAULT, TERMINAL_SCROLLBACK } from "./terminal-config.js";
import {
  encodeHexKeys, unescapeTmuxOutputBytes,
  stripDaResponses, tmuxKillSession,
} from "./tmux.js";

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
   * @param {number} options.maxBufferItems
   * @param {number} options.maxBufferBytes
   * @param {Function} options.onData - Callback: onData(sessionName, fromSeq)
   * @param {Function} options.onExit - Callback for session exit
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
    this._cols = 0;
    this._rows = 0;
    this._lastOutputAt = 0;     // monotonic timestamp of last %output
    this._resizeTimer = null;   // pending resize gate timer
    this._resizeDeadline = 0;   // max deferral cap for resize gate

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
    // Parser state: line buffer + two StringDecoders (one for control-mode
    // framing, one for %output payloads) + carry for partial tmux octal
    // escapes that span %output boundaries. See _resetParserState for the
    // rationale; it's called here and on every reattach.
    this._resetParserState();

    // Headless xterm mirrors all PTY output — used to serialize terminal
    // state (including cursor position) for clients on attach/switch.
    this._headless = new Terminal({ cols: DEFAULT_COLS, rows: TERMINAL_ROWS_DEFAULT, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true });
    this._serializeAddon = new SerializeAddon();
    this._headless.loadAddon(this._serializeAddon);
  }

  get alive() {
    return this.state === Session.STATE_ATTACHED;
  }

  /**
   * Reset all parser state used to decode tmux control-mode stdout.
   *
   * Called from the constructor and again on every `attachControlMode` so
   * a prior detach can't leave a stuck line buffer, half-consumed
   * StringDecoder, or partial octal carry that would corrupt the first
   * bytes of the next attach.
   *
   * State fields:
   * - `_lineBuf`: partial line assembled across stdout chunks
   * - `_decoder`: StringDecoder for the control-mode framing layer
   * - `_outputDecoder`: separate StringDecoder for %output payloads, so
   *   multi-byte UTF-8 chars that span %output lines don't become U+FFFD
   * - `_octalCarry`: 1-3 chars of a partial `\NNN` escape deferred from
   *   the previous %output line (see unescapeTmuxOutputBytes)
   *
   * @private
   */
  _resetParserState() {
    this._lineBuf = "";
    this._decoder = new StringDecoder("utf-8");
    this._outputDecoder = new StringDecoder("utf-8");
    this._octalCarry = "";
  }

  /**
   * Handle a chunk of raw stdout data from the tmux control mode process.
   * Parses %output protocol lines and dispatches terminal data.
   * @private
   */
  _handleStdoutData(chunk) {
    this._lineBuf = (this._lineBuf || "") + this._decoder.write(chunk);
    this._parseLineBuf();
  }

  /**
   * Parse complete lines from _lineBuf and process %output protocol lines.
   * Extracted so it can be called from both _handleStdoutData and the close handler.
   * @private
   */
  _parseLineBuf() {
    let startIdx = 0;
    let nlPos;
    while ((nlPos = this._lineBuf.indexOf("\n", startIdx)) !== -1) {
      const line = this._lineBuf.slice(startIdx, nlPos);
      startIdx = nlPos + 1;

      if (line.startsWith("%output ")) {
        // Format: %output %pane_id octal_escaped_data
        const rest = line.slice(8); // after "%output "
        const spacePos = rest.indexOf(" ");
        if (spacePos !== -1) {
          const escaped = rest.slice(spacePos + 1);
          // Octal → bytes → UTF-8 via _octalCarry + _outputDecoder. See
          // unescapeTmuxOutputBytes for why the carry is load-bearing.
          const { bytes: rawBytes, carry } = unescapeTmuxOutputBytes(
            escaped, this._octalCarry,
          );
          this._octalCarry = carry;
          const data = this._outputDecoder.write(rawBytes);
          if (!data) continue; // incomplete multi-byte char, buffered for next line
          this._lastOutputAt = Date.now();
          const fromSeq = this.outputBuffer.totalBytes;
          this.outputBuffer.push(data);
          if (this._headless) this._headless.write(data);
          if (this._onData) {
            this._onData(this.name, fromSeq);
          }
        }
      }
      // Ignore %begin, %end, %error, %session-changed, etc.
    }
    if (startIdx > 0) this._lineBuf = this._lineBuf.slice(startIdx);
  }

  /**
   * Attach to the tmux session via control mode.
   * Spawns `tmux -u -C attach-session -d -t <name>` as a child process.
   */
  attachControlMode(cols, rows) {
    // Clear any residual parser state from a prior attach before we start
    // streaming bytes from the new tmux process. Must happen before the
    // stdout handler is wired up.
    this._resetParserState();

    const proc = this._spawn("tmux", ["-u", "-C", "attach-session", "-d", "-t", this.tmuxName], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.controlProc = proc;

    // Mark as attached immediately after spawn — before registering event
    // handlers so that close/error events (which can fire on the next tick
    // if tmux exits immediately) see the correct state and call onExit.
    this.state = Session.STATE_ATTACHED;

    // Set initial terminal size
    this._sendControlCmd(`refresh-client -C ${cols}x${rows}`);
    this._headless.resize(cols, rows);

    proc.stdout.on("data", (chunk) => this._handleStdoutData(chunk));

    // Close/error handlers capture `proc` in the closure. If the session
    // is reattached before this process's close event fires, `this._decoder`
    // and friends will have been replaced by `_resetParserState()` for the
    // new attach — calling `.end()` on them here would prematurely flush
    // the NEW decoder and drop buffered UTF-8 bytes on the live stream.
    // Guard with a `this.controlProc !== proc` check so stale events on a
    // superseded process become no-ops.
    proc.on("close", (code) => {
      if (this.controlProc !== proc) return;
      const tail = this._decoder.end();
      if (tail) {
        this._lineBuf = (this._lineBuf || "") + tail;
        // Parse any complete lines delivered via the decoder tail
        this._parseLineBuf();
      }
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
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    if (this.state !== Session.STATE_ATTACHED) return;
    // Skip if dimensions haven't changed — avoids unnecessary SIGWINCH
    // that can garble TUI apps (Claude Code, vim, htop) mid-render.
    if (this._cols === cols && this._rows === rows) return;

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
      // Set deadline on first deferral only
      if (!this._resizeTimer) {
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
    if (this._cols === cols && this._rows === rows) return;
    this._cols = cols;
    this._rows = rows;
    // Tell tmux control mode client about the new size.
    // With window-size=latest, tmux resizes the pane to match.
    // This is processed synchronously on the control mode stdin,
    // so the resize takes effect before any subsequent %output —
    // unlike resize-window (async exec) which races with output
    // and also resets window-size to "manual", breaking future
    // refresh-client resizes.
    this._sendControlCmd(`refresh-client -C ${cols}x${rows}`);
    this._headless.resize(cols, rows);
  }

  /**
   * Seed the headless terminal with captured pane content.
   *
   * After a server restart, the headless xterm is empty because tmux
   * control mode only sends %output for NEW data — it does not replay
   * the existing screen.  For idle sessions (no new output since
   * control mode attached), serializeScreen() would return empty
   * content, causing blank tiles on the client.
   *
   * This method writes captured pane content (from tmux capture-pane)
   * directly to the headless terminal so serializeScreen() returns
   * the current screen state.  The seed data is NOT pushed to the
   * RingBuffer — it must only contain raw %output escape sequences
   * for pull delivery to work correctly.
   *
   * @param {string|null} content - Captured pane text (with ANSI escapes)
   * @param {{ row: number, col: number }|null} [cursorPos] - 1-based cursor position
   */
  async seedScreen(content, cursorPos = null) {
    if (!content || !this._headless) return;

    // Write captured content to headless terminal
    await new Promise(resolve => this._headless.write(content, resolve));

    // Position cursor explicitly if provided (1-based row/col from tmux)
    if (cursorPos && cursorPos.row >= 1 && cursorPos.col >= 1) {
      const cup = `\x1b[${cursorPos.row};${cursorPos.col}H`;
      await new Promise(resolve => this._headless.write(cup, resolve));
    }
  }

  /**
   * Serialize the headless terminal state. Returns escape sequences that
   * reconstruct the terminal buffer including cursor position, colors,
   * and terminal modes when written to a client xterm.js instance.
   *
   * Flushes pending headless writes first — xterm.js batches writes
   * asynchronously via microtasks, so serializing immediately after
   * write() can capture stale state.  The flush ensures the snapshot
   * matches the ring buffer's totalBytes position, preventing the gap
   * where cursor movements and styling from unprocessed writes are
   * missing from the snapshot but skipped by the pull (which starts
   * from totalBytes).  Without this, the pull data is applied on top
   * of a stale terminal state, producing garbled output.
   */
  async serializeScreen() {
    try {
      if (this._headless) {
        await new Promise(resolve => this._headless.write("", resolve));
      }
      return this._serializeAddon.serialize();
    } catch (err) {
      log.warn("Failed to serialize headless terminal", { session: this.name, error: err.message });
      return "";
    }
  }

  /**
   * Compute a fingerprint of the visible terminal screen for drift detection.
   * Uses DJB2 hash of cursor position + visible row content.
   * The same algorithm runs on the client (public/lib/screen-fingerprint.js)
   * so both sides produce identical hashes for identical screen state.
   */
  async screenFingerprint() {
    if (!this._headless) return 0;
    await new Promise(resolve => this._headless.write("", resolve));
    const buf = this._headless.buffer.active;
    let h = 5381;
    // Include dimensions — must match client (public/lib/screen-fingerprint.js)
    h = ((h << 5) + h + this._headless.cols) | 0;
    h = ((h << 5) + h + this._headless.rows) | 0;
    h = ((h << 5) + h + buf.cursorY) | 0;
    h = ((h << 5) + h + buf.cursorX) | 0;
    for (let y = 0; y < this._headless.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      if (!line) continue;
      const text = line.translateToString(true);
      for (let i = 0; i < text.length; i++) {
        h = ((h << 5) + h + text.charCodeAt(i)) | 0;
      }
    }
    return h;
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
    // Prevent stale callbacks from relaying output after close
    this._onData = null;
    clearTimeout(this._resizeTimer);
    this._resizeTimer = null;
    if (this._headless) { this._headless.dispose(); this._headless = null; }

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
   * must not race against this — either wait for the tmux session
   * to disappear (`tmuxHasSession`) or pick a fresh name.
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
