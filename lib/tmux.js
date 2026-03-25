import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { SENSITIVE_ENV_VARS } from "./env-filter.js";
import { log } from "./log.js";

// --- tmux control mode helpers ---

/**
 * Sanitize a session name for tmux (disallows `.`, `:`, and spaces).
 * Katulong allows all printable ASCII in session names but tmux uses
 * some characters as delimiters (. : for window/pane addressing,
 * # for format strings).  These plus spaces are replaced with
 * underscores to keep tmux names safe for shell and tmux commands.
 */
export function tmuxSessionName(name) {
  return name.replace(/[.:#% ]/g, "_");
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
 * Set katulong's bin directory and port in the tmux global environment.
 * This ensures `katulong notes` etc. resolve to the running version even
 * after login shell profile scripts reset PATH. Panes pick up KATULONG_ROOT
 * from tmux's environment and shell integration adds it to PATH.
 */
export async function setTmuxKatulongEnv(binDir, port) {
  await tmuxExec(["start-server"]);
  await Promise.all([
    tmuxExec(["set-environment", "-g", "KATULONG_ROOT", dirname(binDir)]),
    tmuxExec(["set-environment", "-g", "KATULONG_PORT", String(port)]),
    // Update PATH in tmux global env — new panes inherit this
    tmuxExec(["set-environment", "-g", "PATH", `${binDir}:${process.env.PATH || "/usr/bin:/bin"}`]),
  ]);
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
 * Get cursor position (row, col) for a tmux pane.
 * Returns 1-based row/col (ANSI CUP convention), or null on failure.
 */
export async function getCursorPosition(name) {
  const { code, stdout } = await tmuxExec([
    "display-message", "-t", name, "-p", "#{cursor_y},#{cursor_x}",
  ]);
  if (code !== 0) return null;
  const parts = stdout.trim().split(",");
  if (parts.length !== 2) return null;
  const row = parseInt(parts[0], 10);
  const col = parseInt(parts[1], 10);
  if (isNaN(row) || isNaN(col)) return null;
  return { row: row + 1, col: col + 1 };
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
