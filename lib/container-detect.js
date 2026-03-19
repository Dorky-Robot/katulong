/**
 * Container Detection
 *
 * Detects Docker containers that the user has `docker exec`'d into from a
 * tmux pane, and bridges clipboard images into them. This complements the
 * existing kubo-labeled container bridge by handling arbitrary containers.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";

// --- TTL cache for pane container detection ---
const _cache = new Map(); // tmuxName -> { container, ts }
const CACHE_TTL_MS = 10_000;

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
    return arg;
  }

  // After --, next arg is container
  return i < args.length ? args[i] : null;
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
 * Stops at maxDepth to avoid runaway traversals.
 *
 * @param {number} rootPid
 * @param {number} maxDepth
 * @returns {Promise<number[]>}
 */
async function getDescendantPids(rootPid, maxDepth = 3) {
  const all = [];
  let frontier = [rootPid];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier = [];
    for (const pid of frontier) {
      const children = await getChildPids(pid);
      all.push(...children);
      nextFrontier.push(...children);
    }
    frontier = nextFrontier;
  }
  return all;
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
 * Bridge a clipboard image file into a Docker container via `docker exec`.
 * Pipes the file via stdin to avoid requiring volume mounts.
 *
 * @param {string} containerName
 * @param {string} filePath - absolute path to the image file on the host
 * @param {string} mimeType - e.g. "image/png"
 * @param {{ info: Function, warn: Function }} log
 * @returns {Promise<boolean>}
 */
export function bridgeClipboardToContainer(containerName, filePath, mimeType, log) {
  return new Promise((resolve) => {
    const child = execFile("docker", [
      "exec", "-i", "-e", "DISPLAY=:99", containerName,
      "sh", "-c",
      // Ensure Xvfb is running (containers may not start it automatically).
      // Check the X11 socket, not pgrep — zombie Xvfb processes fool pgrep.
      `[ -e /tmp/.X11-unix/X99 ] || { Xvfb :99 -screen 0 1x1x8 -nolisten tcp > /dev/null 2>&1 & sleep 0.5; }; `
      + `cat > /tmp/.kpaste && xclip -selection clipboard -t ${mimeType} -i /tmp/.kpaste && rm -f /tmp/.kpaste`
    ], { timeout: 8000 }, (err) => {
      if (err) {
        log.warn("Pane container clipboard bridge failed", { container: containerName, error: err.message });
        resolve(false);
      } else {
        log.info("Bridged image to pane container clipboard", { container: containerName });
        resolve(true);
      }
    });

    // Pipe the image file to docker exec's stdin
    const stream = createReadStream(filePath);
    stream.pipe(child.stdin);
    stream.on("error", () => {
      try { child.stdin.end(); } catch { /* ignore */ }
    });
  });
}

/** Exposed for testing — clear the detection cache. */
export function _clearCache() {
  _cache.clear();
}

/** Exposed for testing — direct cache access. */
export { _cache };
