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
    } = options;

    this.external = external;
    this.icon = null; // per-session icon override (Phosphor icon name)

    this.outputBuffer = new RingBuffer(maxBufferBytes);
    this._onData = onData;
    this._onExit = onExit;
    this._decoder = new StringDecoder("utf-8");
    // Separate decoder for %output data — handles multi-byte UTF-8
    // characters split across tmux %output boundaries (which produce
    // diamond replacement characters without this).
    this._outputDecoder = new StringDecoder("utf-8");
    // Carry for partial tmux octal escapes (e.g. trailing `\34`) that
    // span %output line boundaries. Without this, a long octal-escaped
    // run like `█████…` (each `█` = `\342\226\210`) split mid-escape
    // produces a cascade of FFFD glyphs. See unescapeTmuxOutputBytes.
    this._octalCarry = "";

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
          // Decode octal → raw bytes, then UTF-8 via persistent decoder.
          // _octalCarry handles partial \NNN escapes split mid-sequence
          // across %output lines (otherwise a trailing `\34` would be
          // misparsed as literal `\` `3` `4` and desync everything that
          // follows). _outputDecoder handles multi-byte UTF-8 characters
          // split across %output lines (e.g. box-drawing ─ = 3 bytes).
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
    this.controlProc = spawn("tmux", ["-u", "-C", "attach-session", "-d", "-t", this.tmuxName], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Mark as attached immediately after spawn — before registering event
    // handlers so that close/error events (which can fire on the next tick
    // if tmux exits immediately) see the correct state and call onExit.
    this.state = Session.STATE_ATTACHED;

    // Set initial terminal size
    this._sendControlCmd(`refresh-client -C ${cols}x${rows}`);
    this._headless.resize(cols, rows);

    // Parse control mode protocol from stdout
    this._lineBuf = "";
    this._decoder = new StringDecoder("utf-8");
    this._octalCarry = "";
    this.controlProc.stdout.on("data", (chunk) => this._handleStdoutData(chunk));

    this.controlProc.on("close", (code) => {
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

    this.controlProc.on("error", (err) => {
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
   * @private
   */
  _closeControlProc() {
    // Prevent stale callbacks from relaying output after close
    this._onData = null;
    clearTimeout(this._resizeTimer);
    this._resizeTimer = null;
    if (this._headless) { this._headless.dispose(); this._headless = null; }
    if (this.controlProc) {
      try {
        this.controlProc.stdin.end();
        this.controlProc.kill();
      } catch { /* already dead */ }
      this.controlProc = null;
    }
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
   */
  kill() {
    if (this.state === Session.STATE_KILLED) return;
    this.state = Session.STATE_KILLED;
    tmuxKillSession(this.tmuxName).catch(err => {
      log.debug("tmux kill-session failed (may already be dead)", { session: this.name, error: err.message });
    });
    this._closeControlProc();
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
