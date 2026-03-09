import { spawn, execFile } from "node:child_process";
import { SENSITIVE_ENV_VARS } from "./env-filter.js";
import { log } from "./log.js";

// --- RingBuffer (inlined from lib/ring-buffer.js) ---

export class RingBuffer {
  constructor(maxItems = 5000, maxBytes = 5 * 1024 * 1024) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.items = [];
    this.bytes = 0;
  }

  push(data) {
    this.items.push(data);
    this.bytes += data.length;
    this.evict();
  }

  evict() {
    let removeCount = 0;
    while (
      this.items.length - removeCount > 1 &&
      (this.items.length - removeCount > this.maxItems || this.bytes > this.maxBytes)
    ) {
      this.bytes -= this.items[removeCount].length;
      removeCount++;
    }
    if (removeCount > 0) {
      this.items.splice(0, removeCount);
    }
  }

  toString() {
    return this.items.join("");
  }

  clear() {
    this.items = [];
    this.bytes = 0;
  }

  stats() {
    return {
      items: this.items.length,
      bytes: this.bytes,
    };
  }
}

// --- tmux control mode helpers ---

/**
 * Sanitize a session name for tmux (disallows `.` and `:`).
 */
export function tmuxSessionName(name) {
  return name.replace(/[.:]/g, "_");
}

/**
 * Encode bytes as hex pairs for `tmux send-keys -H`.
 */
export function encodeHexKeys(data) {
  const buf = Buffer.from(data);
  const parts = [];
  for (let i = 0; i < buf.length; i++) {
    parts.push(buf[i].toString(16).padStart(2, "0"));
  }
  return parts.join(" ");
}

/**
 * Unescape tmux control mode octal encoding.
 * tmux replaces chars < ASCII 32 and `\` with octal: \015 for CR, \012 for LF, \134 for \.
 */
export function unescapeTmuxOutput(s) {
  const result = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 3 < s.length) {
      const d0 = s.charCodeAt(i + 1) - 48; // '0' = 48
      const d1 = s.charCodeAt(i + 2) - 48;
      const d2 = s.charCodeAt(i + 3) - 48;
      if (
        d0 >= 0 && d0 <= 7 &&
        d1 >= 0 && d1 <= 7 &&
        d2 >= 0 && d2 <= 7
      ) {
        const val = d0 * 64 + d1 * 8 + d2;
        if (val <= 255) {
          result.push(String.fromCharCode(val));
          i += 4;
          continue;
        }
      }
    }
    result.push(s[i]);
    i++;
  }
  return result.join("");
}

/**
 * Strip DA (Device Attributes) response sequences from stdin data.
 * xterm.js responds to DA queries (sent by tmux) with sequences like
 * `ESC[?1;2c` (DA1) and `ESC[>0;276;0c` (DA2). If these reach tmux stdin,
 * the trailing characters can trigger keybindings (e.g. `c` = new-window).
 */
export function stripDaResponses(data) {
  let result = "";
  let i = 0;
  while (i < data.length) {
    if (data[i] === "\x1b" && i + 1 < data.length && data[i + 1] === "[") {
      // CSI sequence: ESC[
      let j = i + 2;
      if (j < data.length && (data[j] === "?" || data[j] === ">")) {
        const prefix = data[j];
        j++;
        // Consume parameter bytes (digits and ;)
        let params = "";
        while (j < data.length && (/[0-9;]/).test(data[j])) {
          params += data[j];
          j++;
        }
        if (j < data.length && data[j] === "c") {
          // This is a DA response — strip it
          i = j + 1;
          continue;
        }
        // Not a DA response — replay the full sequence
        result += "\x1b[" + prefix + params;
        i = j;
        continue;
      }
      // Not a DA response prefix — preserve ESC[
      result += "\x1b[";
      i = j;
      continue;
    }
    result += data[i];
    i++;
  }
  return result;
}

// --- tmux command helpers ---

/**
 * Run a tmux command and return { code, stdout }.
 */
export function tmuxExec(args) {
  return new Promise((resolve) => {
    execFile("tmux", args, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

/**
 * Check if tmux is available on the host.
 */
export async function checkTmux() {
  return new Promise((resolve) => {
    execFile("which", ["tmux"], (err) => resolve(!err));
  });
}

/**
 * Remove sensitive environment variables from the tmux server's global environment.
 * Defense-in-depth: getSafeEnv() in session-manager is the primary control that filters
 * env vars per-session at spawn time. This function cleans the tmux server's own env
 * tables so vars like CLAUDECODE don't leak via tmux's inheritance to all panes.
 * Must run once at startup after confirming tmux is available.
 */
export async function cleanTmuxServerEnv() {
  const removals = [];
  for (const varName of SENSITIVE_ENV_VARS) {
    // tmux tracks two env tables: global (-g) and session default (no flag).
    // -gr removes from the global table; -r removes from the session default.
    // Both must be cleared because new sessions can inherit from either.
    removals.push(tmuxExec(["set-environment", "-gr", varName]));
    removals.push(tmuxExec(["set-environment", "-r", varName]));
  }
  const results = await Promise.all(removals);
  const failed = results.filter(r => r.code !== 0);
  if (failed.length > 0) {
    log.warn("cleanTmuxServerEnv: some removals failed (tmux server may not be running)", { count: failed.length });
  }
}

/**
 * Check if a tmux session exists.
 */
export async function tmuxHasSession(name) {
  const { code } = await tmuxExec(["has-session", "-t", name]);
  return code === 0;
}

/**
 * Create a new tmux session (detached).
 */
export async function tmuxNewSession(name, cols, rows, shell, env, cwd) {
  const envParts = [];
  for (const [k, v] of Object.entries(env)) {
    // Validate key: alphanumeric + underscore, not starting with digit
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      const escaped = v.replace(/'/g, "'\\''");
      envParts.push(`export ${k}='${escaped}';`);
    }
  }

  const cwdPart = cwd ? `'${cwd.replace(/'/g, "'\\''")}'` : "$HOME";
  const shellCmd = `${envParts.join(" ")} cd ${cwdPart} 2>/dev/null; exec ${shell} -l`;

  const x = String(cols);
  const y = String(rows);

  const { code, stderr } = await tmuxExec([
    "new-session", "-d", "-s", name, "-x", x, "-y", y,
    "/bin/sh", "-c", shellCmd,
  ]);

  if (code !== 0) {
    throw new Error(`tmux new-session failed: ${stderr}`);
  }

  // Set history limit
  await tmuxExec(["set-option", "-t", name, "history-limit", "50000"]);

  // Apply standard options + unbind split keys
  await applyTmuxSessionOptions(name);
  await Promise.all([
    tmuxExec(["unbind-key", "\""]),
    tmuxExec(["unbind-key", "%"]),
  ]);
}

/**
 * Apply standard tmux session options. Called on both new and reattach.
 */
export async function applyTmuxSessionOptions(name) {
  await Promise.all([
    tmuxExec(["set-option", "-t", name, "status", "off"]),
    tmuxExec(["set-option", "-t", name, "window-size", "latest"]),
    tmuxExec(["set-option", "-t", name, "aggressive-resize", "on"]),
  ]);
}

/**
 * Capture tmux scrollback (ANSI-colored).
 */
export async function captureScrollback(name) {
  const { code, stdout } = await tmuxExec([
    "capture-pane", "-t", name, "-p", "-e", "-S", "-5000",
  ]);
  if (code === 0 && stdout.trim()) return stdout;
  return null;
}

/**
 * List all tmux sessions.
 * @returns {Promise<string[]>} Array of tmux session names
 */
export async function tmuxListSessions() {
  const { code, stdout } = await tmuxExec(["list-sessions", "-F", "#{session_name}"]);
  if (code !== 0 || !stdout.trim()) return [];
  return stdout.trim().split("\n").filter(Boolean);
}

/**
 * Kill a tmux session.
 */
export async function tmuxKillSession(name) {
  await tmuxExec(["kill-session", "-t", name]);
}

/**
 * Resize a tmux window (fire-and-forget).
 */
export function tmuxResizeWindow(name, cols, rows) {
  tmuxExec(["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
}


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
  constructor(name, tmuxName, options = {}) {
    this.name = name;
    this.tmuxName = tmuxName;
    this.alive = true;
    this.controlProc = null;
    this.lastKnownChildCount = 0;
    this.external = false; // true for sessions discovered from tmux, not created by katulong

    const {
      maxBufferItems = 5000,
      maxBufferBytes = 5 * 1024 * 1024,
      onData,
      onExit,
    } = options;

    this.outputBuffer = new RingBuffer(maxBufferItems, maxBufferBytes);
    this._onData = onData;
    this._onExit = onExit;
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
    let lineBuf = "";
    this.controlProc.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString();
      let nlPos;
      while ((nlPos = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, nlPos);
        lineBuf = lineBuf.slice(nlPos + 1);

        if (line.startsWith("%output ")) {
          // Format: %output %pane_id octal_escaped_data
          const rest = line.slice(8); // after "%output "
          const spacePos = rest.indexOf(" ");
          if (spacePos !== -1) {
            const escaped = rest.slice(spacePos + 1);
            const data = unescapeTmuxOutput(escaped);
            this.outputBuffer.push(data);
            if (this._onData) {
              this._onData(this.name, data);
            }
          }
        }
        // Ignore %begin, %end, %error, %session-changed, etc.
      }
    });

    this.controlProc.on("close", (code) => {
      if (this.alive) {
        this.alive = false;
        if (this._onExit) {
          this._onExit(this.name, code ?? 0);
        }
      }
    });

    this.controlProc.on("error", (err) => {
      if (this.alive) {
        this.alive = false;
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
    if (!this.alive) {
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
    if (!this.alive) return;
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
    if (!this.alive) return;
    this.alive = false;
    this._closeControlProc();
  }

  /**
   * Kill the tmux session and control mode process.
   */
  kill() {
    if (!this.alive) return;
    this.alive = false;
    tmuxKillSession(this.tmuxName);
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
