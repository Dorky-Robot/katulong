import { spawn, execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
  const bytes = [];
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
          bytes.push(val);
          i += 4;
          continue;
        }
      }
    }
    // Non-escaped character: encode as UTF-8 bytes
    const cp = s.codePointAt(i);
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
      i++; // extra advance for surrogate pair (2 JS chars = 1 code point)
    }
    i++;
  }
  return Buffer.from(bytes).toString("utf-8");
}

/**
 * Strip terminal query responses from stdin data that xterm.js echoes back.
 *
 * xterm.js responds to queries sent by programs running in the terminal:
 * - DA1: ESC[?1;2c  (Device Attributes, triggered by ESC[c)
 * - DA2: ESC[>0;276;0c  (Secondary DA, triggered by ESC[>c)
 * - CPR: ESC[row;colR  (Cursor Position Report, triggered by ESC[6n)
 *
 * If these reach tmux stdin via send-keys, trailing chars like `c` or `R`
 * can trigger tmux keybindings (e.g. `c` = new-window, `R` = redraw).
 * CPR responses also interfere with TUI apps like Claude Code that send
 * DSR queries and expect to consume the response from their own stdin.
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
          // DA1/DA2 response — strip it
          i = j + 1;
          continue;
        }
        // Not a DA response — replay the full sequence
        result += "\x1b[" + prefix + params;
        i = j;
        continue;
      }
      // Check for CPR: ESC[digits;digitsR (no prefix char)
      {
        let k = j;
        let cprParams = "";
        while (k < data.length && (/[0-9;]/).test(data[k])) {
          cprParams += data[k];
          k++;
        }
        if (k < data.length && data[k] === "R" && cprParams.includes(";")) {
          // CPR response (e.g. ESC[35;1R) — strip it
          i = k + 1;
          continue;
        }
      }
      // Not a query response — preserve ESC[
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
  // Ensure tmux server is running — set-environment requires an active server.
  // start-server is idempotent (no-op if already running).
  await tmuxExec(["start-server"]);

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
    tmuxExec(["set-option", "-t", name, "default-terminal", "xterm-256color"]),
  ]);
}

/**
 * Capture the currently visible pane content (ANSI-colored).
 * Unlike captureScrollback, this captures only the visible screen — safe to
 * replay on reconnect because it's pre-rendered text, not raw cursor escapes.
 */
export async function captureVisiblePane(name) {
  const { code, stdout } = await tmuxExec([
    "capture-pane", "-t", name, "-p", "-e",
  ]);
  if (code === 0 && stdout.trim()) return stdout;
  return null;
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
 * List tmux sessions that have non-control-mode clients attached.
 * @returns {Promise<Set<string>>} Set of session names with external clients (e.g. SSH, terminal)
 */
export async function tmuxListSessionsDetailed() {
  // Get all clients with their session + flags
  const { code, stdout } = await tmuxExec([
    "list-clients", "-F", "#{client_session}\t#{client_flags}"
  ]);
  const externalSessions = new Set();
  if (code === 0 && stdout.trim()) {
    for (const line of stdout.trim().split("\n")) {
      const [session, flags] = line.split("\t");
      if (session && flags && !flags.includes("control-mode")) {
        externalSessions.add(session);
      }
    }
  }
  return externalSessions;
}

/**
 * Kill a tmux session.
 */
export async function tmuxKillSession(name) {
  const { code, stderr } = await tmuxExec(["kill-session", "-t", name]);
  if (code !== 0) throw new Error(stderr.trim() || "kill-session failed");
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
