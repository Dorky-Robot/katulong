/**
 * Container Clipboard Bridge
 *
 * Detects Docker containers that the user has `docker exec`'d into from a
 * tmux pane, and bridges clipboard images into them. Also handles kubo-labeled
 * containers. All clipboard-to-container bridging is consolidated here.
 *
 * Two bridge strategies:
 * - Kubo containers: xclip reads from a mounted file path (kubo mounts
 *   ~/.katulong/uploads into containers at /home/dev/.katulong/uploads)
 * - Pane containers: image is piped via stdin to avoid requiring volume mounts,
 *   since arbitrary docker exec'd containers have no guaranteed mount
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";

// Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]*
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,253}$/;

// --- TTL cache for pane container detection ---
const _cache = new Map(); // tmuxName -> { container, ts }
const CACHE_TTL_MS = 10_000;

// --- Docker availability cache ---
let _dockerAvailable = null; // null = unchecked, true/false = cached

// Xvfb ensure snippet — used by both bridge functions
const ENSURE_XVFB = `[ -e /tmp/.X11-unix/X99 ] || { Xvfb :99 -screen 0 1x1x8 -nolisten tcp > /dev/null 2>&1 & sleep 0.5; }; `;

// Max total PIDs to visit during descendant traversal (prevents DoS from
// process-heavy workloads like build systems)
const MAX_DESCENDANT_PIDS = 50;

/**
 * Parse a `docker exec` command line to extract the container name.
 * Skips `docker exec`, flags (with known value-taking flags), and returns
 * the first positional argument (the container name).
 *
 * @param {string[]} args - command arguments (e.g. ["docker", "exec", "-it", "mycontainer", "bash"])
 * @returns {string|null} container name or null
 */
export function parseContainerFromArgs(args) {
  // Find "docker" and "exec" in args
  let i = 0;
  // Skip to "docker"
  while (i < args.length && !args[i].endsWith("docker")) i++;
  if (i >= args.length) return null;
  i++;
  // Next should be "exec"
  if (i >= args.length || args[i] !== "exec") return null;
  i++;

  // Flags that consume the next argument as a value
  const valueTakers = new Set([
    "-e", "--env", "--env-file",
    "-u", "--user",
    "-w", "--workdir",
  ]);

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") { i++; break; }
    // Combined short flags like -it, -eit, etc.
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2) {
      // Check if any char is a value-taker (e.g. -e in -eit)
      // -e takes a value, so if present the next arg is the value
      if (arg.includes("e")) { i += 2; continue; }
      i++;
      continue;
    }
    if (valueTakers.has(arg)) { i += 2; continue; }
    if (arg.startsWith("--") && arg.includes("=")) { i++; continue; }
    // Boolean flags
    if (arg.startsWith("-")) { i++; continue; }
    // First non-flag argument is the container name
    return CONTAINER_NAME_RE.test(arg) ? arg : null;
  }

  // After --, next arg is container
  if (i < args.length && CONTAINER_NAME_RE.test(args[i])) return args[i];
  return null;
}

/**
 * Read command line args for a given PID.
 * Tries /proc/<pid>/cmdline first (Linux), falls back to ps (macOS).
 *
 * @param {number} pid
 * @returns {Promise<string[]|null>}
 */
async function readCmdline(pid) {
  try {
    const data = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const args = data.split("\0").filter(Boolean);
    return args.length > 0 ? args : null;
  } catch {
    // Fallback: ps (works on macOS)
    return new Promise((resolve) => {
      execFile("ps", ["-o", "args=", "-p", String(pid)], { timeout: 3000 }, (err, stdout) => {
        if (err || !stdout?.trim()) return resolve(null);
        // ps outputs space-separated args (imperfect but workable)
        resolve(stdout.trim().split(/\s+/));
      });
    });
  }
}

/**
 * Get direct child PIDs of a given PID.
 *
 * @param {number} parentPid
 * @returns {Promise<number[]>}
 */
function getChildPids(parentPid) {
  return new Promise((resolve) => {
    execFile("pgrep", ["-P", String(parentPid)], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout?.trim()) return resolve([]);
      resolve(stdout.trim().split("\n").map(Number).filter(n => !isNaN(n)));
    });
  });
}

/**
 * Get all descendant PIDs of a given PID (breadth-first).
 * Stops at maxDepth and MAX_DESCENDANT_PIDS to avoid runaway traversals.
 *
 * @param {number} rootPid
 * @param {number} maxDepth
 * @returns {Promise<number[]>}
 */
async function getDescendantPids(rootPid, maxDepth = 3) {
  const visited = new Set([rootPid]);
  const descendantPids = [];
  let frontier = [rootPid];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier = [];
    for (const pid of frontier) {
      const children = await getChildPids(pid);
      for (const child of children) {
        if (visited.has(child)) continue;
        visited.add(child);
        descendantPids.push(child);
        nextFrontier.push(child);
        if (descendantPids.length >= MAX_DESCENDANT_PIDS) return descendantPids;
      }
    }
    frontier = nextFrontier;
  }
  return descendantPids;
}

/**
 * Detect the Docker container that the active tmux pane is exec'd into.
 *
 * @param {string} tmuxName - tmux session name
 * @returns {Promise<string|null>} container name or null
 */
export async function detectPaneContainer(tmuxName) {
  // Check cache
  const cached = _cache.get(tmuxName);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.container;
  }

  try {
    // Get the ACTIVE pane PID (not the first pane — matters for multi-pane layouts)
    const panePid = await new Promise((resolve, reject) => {
      execFile("tmux", ["display-message", "-t", tmuxName, "-p", "#{pane_pid}"],
        { timeout: 3000 }, (err, stdout) => {
          if (err) return reject(err);
          const pid = parseInt(stdout?.trim(), 10);
          isNaN(pid) ? reject(new Error("No pane PID")) : resolve(pid);
        });
    });

    // Search descendants (not just direct children) — handles wrapper scripts,
    // subshells, and other intermediate processes between the pane shell and
    // the docker exec process.
    const descendants = await getDescendantPids(panePid);

    for (const pid of descendants) {
      const args = await readCmdline(pid);
      if (!args) continue;
      const container = parseContainerFromArgs(args);
      if (container) {
        _cache.set(tmuxName, { container, ts: Date.now() });
        return container;
      }
    }

    // No docker exec found
    _cache.set(tmuxName, { container: null, ts: Date.now() });
    return null;
  } catch {
    return null;
  }
}

/**
 * Bridge uploaded image to running kubo containers' X clipboards.
 *
 * kubo containers run their own Xvfb (:99) isolated from the host.
 * The host clipboard (set via osascript or host xclip) isn't visible
 * inside containers. But kubo mounts ~/.katulong/uploads into the
 * container at /home/dev/.katulong/uploads, so the uploaded file is
 * accessible. We use `docker exec` to run xclip inside each container.
 *
 * Returns true if at least one container clipboard was set successfully.
 * Must be awaited before returning the upload response — otherwise the
 * client sends Ctrl+V before the container clipboard is ready.
 */
export function bridgeClipboardToContainers(filename, mimeType, log) {
  // Fast path: if we already know docker isn't available, skip immediately
  if (_dockerAvailable === false) return Promise.resolve(false);

  return new Promise((resolve) => {
    execFile("docker", [
      "ps", "--filter", "label=managed-by=kubo", "--format", "{{.Names}}"
    ], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        // Cache docker unavailability (ENOENT = not installed)
        if (err.code === "ENOENT") _dockerAvailable = false;
        return resolve(false);
      }
      _dockerAvailable = true;
      if (!stdout?.trim()) return resolve(false);
      const containers = stdout.trim().split("\n").filter(Boolean);
      if (containers.length === 0) return resolve(false);

      let pending = containers.length;
      let anySuccess = false;

      for (const name of containers) {
        execFile("docker", [
          "exec", "-e", "DISPLAY=:99", name,
          "sh", "-c",
          // Ensure Xvfb is running (containers may not start it automatically).
          // Check the X11 socket, not pgrep — zombie Xvfb processes fool pgrep.
          ENSURE_XVFB
          + `xclip -selection clipboard -t '${mimeType}' -i '/home/dev/.katulong/uploads/${filename}'`
        ], { timeout: 8000 }, (execErr) => {
          if (execErr) {
            log.warn("Container clipboard bridge failed", { container: name, error: execErr.message });
          } else {
            log.info("Bridged image to container clipboard", { container: name, filename });
            anySuccess = true;
          }
          if (--pending === 0) resolve(anySuccess);
        });
      }
    });
  });
}

/**
 * Bridge a clipboard image file into a Docker container via `docker exec`.
 * Pipes the file via stdin to avoid requiring volume mounts — unlike kubo
 * containers, arbitrary docker exec'd containers have no guaranteed mount.
 *
 * @param {string} containerName
 * @param {string} filePath - absolute path to the image file on the host
 * @param {string} mimeType - e.g. "image/png"
 * @param {{ info: Function, warn: Function }} log
 * @returns {Promise<boolean>}
 */
/**
 * Bridge clipboard to the container in a session's active tmux pane.
 * Combines detection + bridging into a single call for use by routes.
 *
 * @param {string} sessionName
 * @param {object} sessionManager
 * @param {string} filePath
 * @param {string} mimeType
 * @param {{ info: Function, warn: Function }} log
 * @returns {Promise<boolean>}
 */
export async function bridgePaneContainer(sessionName, sessionManager, filePath, mimeType, log) {
  const session = sessionManager.getSession(sessionName);
  if (!session) return false;

  const container = await detectPaneContainer(session.tmuxName);
  if (!container) return false;

  const bridged = await bridgeClipboardToContainer(container, filePath, mimeType, log);
  return bridged;
}

/** Exposed for testing — clear the detection cache. */
export function _clearCache() {
  _cache.clear();
}

/** Exposed for testing — direct cache access. */
export { _cache };
