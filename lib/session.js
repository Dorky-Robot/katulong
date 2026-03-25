import { spawn, execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { log } from "./log.js";
import { RingBuffer } from "./ring-buffer.js";
import {
  encodeHexKeys, unescapeTmuxOutput,
  stripDaResponses, tmuxKillSession,
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
   * @param {Function} options.onSnapshot - Callback for screen snapshots: (sessionName, data) => void
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

    const {
      maxBufferBytes = 20 * 1024 * 1024,
      external = false,
      onSnapshot,
      onExit,
    } = options;

    this.external = external;
    this.icon = null; // per-session icon override (Phosphor icon name)

    this.outputBuffer = new RingBuffer(maxBufferBytes);
    this._onSnapshot = onSnapshot;
    this._onExit = onExit;
    this._decoder = new StringDecoder("utf-8");

    // Snapshot loop state
    this._snapshotTimer = null;
    this._lastOutputTime = 0;
    this._lastSnapshotLines = null; // array of lines from last sent snapshot
    this._lastCursorX = 0;
    this._lastCursorY = 0;
  }

  /**
   * Diff two line arrays and produce mutations.
   * Detects scroll (lines shifted up) vs in-place edits.
   * Returns { type: "scroll", count, newLines } or { type: "mutations", rows }
   */
  static _diffSnapshots(prev, curr) {
    if (!prev || prev.length !== curr.length) {
      // Size changed — full repaint
      return { type: "full" };
    }

    const len = curr.length;

    // Detect scroll: check if prev[n..end] === curr[0..end-n] for some n
    // (lines shifted up by n, n new lines at the bottom)
    for (let shift = 1; shift <= Math.min(len - 1, 10); shift++) {
      let match = true;
      for (let i = 0; i < len - shift; i++) {
        if (prev[i + shift] !== curr[i]) { match = false; break; }
      }
      if (match) {
        // Bottom `shift` lines are new content after scroll
        const newLines = [];
        for (let i = len - shift; i < len; i++) {
          newLines.push(curr[i]);
        }
        return { type: "scroll", count: shift, newLines };
      }
    }

    // No scroll detected — find changed rows
    const rows = [];
    for (let i = 0; i < len; i++) {
      if (prev[i] !== curr[i]) {
        rows.push({ row: i, content: curr[i] });
      }
    }
    if (rows.length === 0) return null; // identical
    // If most rows changed (e.g., screen buffer switch), do full repaint
    // so stale content from the alternate screen gets cleared
    if (rows.length > len * 0.5) return { type: "full" };
    return { type: "mutations", rows };
  }

  /** Capture a single frame (pane + cursor) and emit diff/mutation. */
  _captureFrame() {
    if (!this._onSnapshot) return;
    let paneData = null, cursorX = 0, cursorY = 0, pending = 2;
    const done = () => {
      if (--pending > 0) return;
      if (!paneData) return;
      const lines = paneData.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

      const prev = this._lastSnapshotLines;
      this._lastSnapshotLines = lines;

      if (!prev) {
        if (this._onSnapshot) this._onSnapshot(this.name, { type: "full", lines, cursorX, cursorY });
        return;
      }

      const diff = Session._diffSnapshots(prev, lines);
      if (!diff) {
        // Lines identical but cursor may have moved
        if (cursorX !== this._lastCursorX || cursorY !== this._lastCursorY) {
          this._lastCursorX = cursorX;
          this._lastCursorY = cursorY;
          if (this._onSnapshot) this._onSnapshot(this.name, { type: "cursor", cursorX, cursorY });
        }
        return;
      }
      this._lastCursorX = cursorX;
      this._lastCursorY = cursorY;
      if (diff.type === "full") diff.lines = lines;
      if (diff.type === "scroll") diff.lines = lines;
      diff.cursorX = cursorX;
      diff.cursorY = cursorY;
      if (this._onSnapshot) this._onSnapshot(this.name, diff);
    };

    execFile("tmux", ["capture-pane", "-t", this.tmuxName, "-p", "-e"],
      { timeout: 5000 }, (err, stdout) => {
        if (!err && stdout) paneData = stdout;
        done();
      });
    execFile("tmux", ["display-message", "-t", this.tmuxName, "-p", "#{cursor_x},#{cursor_y}"],
      { timeout: 5000 }, (err, stdout) => {
        if (!err && stdout) {
          const parts = stdout.trim().split(",");
          cursorX = parseInt(parts[0], 10) || 0;
          cursorY = parseInt(parts[1], 10) || 0;
        }
        done();
      });
  }

  /** Start the snapshot capture loop (~30fps) if not already running. */
  _startSnapshotLoop() {
    // Fire an immediate capture on first activity
    if (!this._snapshotTimer) this._captureFrame();
    if (this._snapshotTimer) return;
    this._snapshotTimer = setInterval(() => {
      if (Date.now() - this._lastOutputTime > 500) {
        // Do one final capture to ensure we have the latest state
        this._captureFrame();
        this._stopSnapshotLoop();
        return;
      }
      this._captureFrame();
    }, 16); // ~60fps
  }

  /** Stop the snapshot capture loop. */
  _stopSnapshotLoop() {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
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
          // Signal activity — snapshot loop will capture the screen
          this._lastOutputTime = Date.now();
          this._startSnapshotLoop();
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

    // Mark as attached immediately after spawn — before registering event
    // handlers so that close/error events (which can fire on the next tick
    // if tmux exits immediately) see the correct state and call onExit.
    this.state = Session.STATE_ATTACHED;

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
    // Tell tmux control mode client about the new size.
    // With window-size=latest, tmux resizes the pane to match.
    // This is processed synchronously on the control mode stdin,
    // so the resize takes effect before any subsequent %output —
    // unlike resize-window (async exec) which races with output
    // and also resets window-size to "manual", breaking future
    // refresh-client resizes.
    this._sendControlCmd(`refresh-client -C ${cols}x${rows}`);
  }

  /**
   * Close the control mode process without killing the tmux session.
   * @private
   */
  _closeControlProc() {
    // Prevent stale callbacks from relaying output after close
    this._onSnapshot = null;
    this._stopSnapshotLoop();
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
