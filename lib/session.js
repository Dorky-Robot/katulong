import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { log } from "./log.js";
import { RingBuffer } from "./ring-buffer.js";
import {
  tmuxResizeWindow, encodeHexKeys, unescapeTmuxOutput,
  stripDaResponses, tmuxKillSession,
} from "./tmux.js";

// Re-export for backwards compatibility
export { RingBuffer } from "./ring-buffer.js";
export {
  tmuxSessionName, encodeHexKeys, unescapeTmuxOutput, stripDaResponses,
  tmuxExec, checkTmux, cleanTmuxServerEnv, tmuxHasSession, tmuxNewSession,
  applyTmuxSessionOptions, captureVisiblePane, captureScrollback,
  tmuxListSessions, tmuxListSessionsDetailed, tmuxKillSession, tmuxResizeWindow,
} from "./tmux.js";

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
   * @param {Function} options.onData - Callback for terminal output
   * @param {Function} options.onExit - Callback for session exit
   */
  // Session lifecycle states
  static STATE_ATTACHED = "attached";
  static STATE_DETACHED = "detached";
  static STATE_KILLED = "killed";

  constructor(name, tmuxName, options = {}) {
    this.name = name;
    this.tmuxName = tmuxName;
    this.state = Session.STATE_ATTACHED;
    this.controlProc = null;
    this.lastKnownChildCount = 0;
    this.external = false; // true for sessions discovered from tmux, not created by katulong
    this._cols = 0;
    this._rows = 0;

    const {
      maxBufferItems = 5000,
      maxBufferBytes = 5 * 1024 * 1024,
      onData,
      onExit,
    } = options;

    this.outputBuffer = new RingBuffer(maxBufferItems, maxBufferBytes);
    this._onData = onData;
    this._onExit = onExit;
    this._decoder = new StringDecoder("utf-8");

    // Output coalescing — buffer rapid-fire %output chunks and flush them
    // as a single write to reduce partial-frame rendering artifacts in TUI apps.
    this._coalesceBuffer = "";
    this._coalesceTimer = null;
    this._coalesceIntervalMs = 8; // half a 60fps frame
  }

  get alive() {
    return this.state === Session.STATE_ATTACHED;
  }

  /**
   * Flush any pending coalesced output to the _onData callback.
   * @private
   */
  _flushCoalesced() {
    if (this._coalesceTimer) {
      clearTimeout(this._coalesceTimer);
      this._coalesceTimer = null;
    }
    if (!this._coalesceBuffer) return;
    const data = this._coalesceBuffer;
    this._coalesceBuffer = "";
    if (this._onData) {
      this._onData(this.name, data);
    }
  }

  /**
   * Handle a chunk of raw stdout data from the tmux control mode process.
   * Parses %output protocol lines and coalesces terminal data for dispatch.
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
    let nlPos;
    while ((nlPos = this._lineBuf.indexOf("\n")) !== -1) {
      const line = this._lineBuf.slice(0, nlPos);
      this._lineBuf = this._lineBuf.slice(nlPos + 1);

      if (line.startsWith("%output ")) {
        // Format: %output %pane_id octal_escaped_data
        const rest = line.slice(8); // after "%output "
        const spacePos = rest.indexOf(" ");
        if (spacePos !== -1) {
          const escaped = rest.slice(spacePos + 1);
          const data = unescapeTmuxOutput(escaped);
          this.outputBuffer.push(data);
          // Coalesce rapid output into a single _onData dispatch.
          // The timer fires 8ms after the first chunk in a burst,
          // collecting all subsequent chunks within that window.
          this._coalesceBuffer += data;
          if (!this._coalesceTimer) {
            this._coalesceTimer = setTimeout(() => this._flushCoalesced(), this._coalesceIntervalMs);
          }
        }
      }
      // Ignore %begin, %end, %error, %session-changed, etc.
    }
  }

  /**
   * Attach to the tmux session via control mode.
   * Spawns `tmux -u -C attach-session -d -t <name>` as a child process.
   */
  attachControlMode(cols, rows) {
    this.controlProc = spawn("tmux", ["-u", "-C", "attach-session", "-d", "-t", this.tmuxName], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Set initial terminal size
    this._sendControlCmd(`refresh-client -C ${cols}x${rows}`);

    // Parse control mode protocol from stdout
    this._lineBuf = "";
    this._decoder = new StringDecoder("utf-8");
    this.controlProc.stdout.on("data", (chunk) => this._handleStdoutData(chunk));

    this.controlProc.on("close", (code) => {
      const tail = this._decoder.end();
      if (tail) {
        this._lineBuf = (this._lineBuf || "") + tail;
        // Parse any complete lines delivered via the decoder tail
        this._parseLineBuf();
      }
      this._flushCoalesced();
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
    this._cols = cols;
    this._rows = rows;
    // Tell tmux control mode client about the new size
    this._sendControlCmd(`refresh-client -C ${cols}x${rows}`);
    // Also resize the tmux window directly for other attached clients
    tmuxResizeWindow(this.tmuxName, cols, rows);
  }

  /**
   * Close the control mode process without killing the tmux session.
   * @private
   */
  _closeControlProc() {
    this._flushCoalesced();
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
   * Check if the session has running child processes.
   * @returns {boolean}
   */
  hasChildProcesses() {
    if (!this.alive) return false;
    return this.lastKnownChildCount > 1;
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
    };
  }
}
