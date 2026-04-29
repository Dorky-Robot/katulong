/**
 * Drift diagnostic logger.
 *
 * Env-gated JSONL logger for investigating client/server terminal state
 * divergence — stacked spinners, leftover TUI fragments, U+FFFD bursts,
 * backpressure drops, pull-bypass byte loss, etc. Off unless enabled via
 * env var, so production has zero overhead.
 *
 * Enabling
 *   KATULONG_DRIFT_LOG=1   high-level events (flushes with FFFD, relay
 *                          backpressure, pull-bypass, eviction, resync).
 *                          Cheap enough to leave on for days to catch a
 *                          rare bug without drowning the disk.
 *   KATULONG_DRIFT_LOG=2   everything above + deep byte-level probes
 *                          (parser-fffd with raw chunk hex dumps).
 *                          Noisy — turn on when reproducing a known bug.
 *
 *   KATULONG_DRIFT_DEBUG=1 legacy alias for level 1. Kept so existing
 *                          bin/debug-drift.sh invocations and prior
 *                          documentation still work.
 *
 * Log location: <KATULONG_DATA_DIR>/drift.log (one JSON object per line),
 * defaulting to ~/.katulong/drift.log when no override is set.
 *
 * Event types emitted
 *   level 1:
 *     flush              output coalescer flushed bytes to relay (only
 *                        logged when the flushed payload contains FFFD)
 *     relay-backpressure output relay dropped to data-available notify
 *                        (safe — bytes stay in RingBuffer for later pull)
 *     pull-bypass        pull handler skipped the client cursor to HEAD
 *                        under backpressure (BYTE LOSS — clients miss
 *                        the intervening range, producing cursor/scroll
 *                        drift that compounds)
 *     pull-eviction      client cursor fell out of RingBuffer → snapshot
 *     resync             client detected drift and requested snapshot
 *   level 2 (adds):
 *     parser-fffd        tmux parser emitted U+FFFD; includes raw stdout
 *                        chunk hex dumps, the escaped payload hex, and
 *                        decoded context around the first FFFD
 *
 * Design notes
 * - Writes are fire-and-forget: failures never throw into the hot path.
 * - The stream is opened lazily on first log so a disabled logger does
 *   not create the data dir at startup.
 * - `driftLogLevel()` is a cheap getter callers can use to avoid
 *   building an expensive log payload (hex dumps, rolling-buffer
 *   stringification) when the level is below the threshold.
 */

import fs from "node:fs";
import path from "node:path";
import envConfig from "./env-config.js";

const LOG_PATH = path.join(envConfig.dataDir, "drift.log");

function parseLevel() {
  const raw = process.env.KATULONG_DRIFT_LOG;
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  // Legacy alias — KATULONG_DRIFT_DEBUG=1 means level 1.
  if (process.env.KATULONG_DRIFT_DEBUG === "1") return 1;
  return 0;
}

const LEVEL = parseLevel();

let stream = null;

function ensureStream() {
  if (stream) return stream;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    // mode 0o600: the log can contain diagnostic fragments of terminal
    // I/O at level 2 (hex dumps of raw stdout chunks). Restrict to
    // owner-only so a shared host does not leak terminal context.
    stream = fs.createWriteStream(LOG_PATH, { flags: "a", mode: 0o600 });
    stream.write(JSON.stringify({
      ts: Date.now(),
      event: "log-open",
      level: LEVEL,
      pid: process.pid,
    }) + "\n");
  } catch {
    stream = null;
  }
  return stream;
}

/**
 * Write a log entry if the current level is >= `minLevel`.
 *
 * @param {object} entry - JSON-serializable fields. `ts` is added automatically.
 * @param {number} [minLevel=1] - minimum KATULONG_DRIFT_LOG level required.
 */
export function driftLog(entry, minLevel = 1) {
  if (LEVEL < minLevel) return;
  const s = ensureStream();
  if (!s) return;
  try {
    s.write(JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {
    // Never let logging throw into the hot path.
  }
}

/**
 * Current drift log level (0 = off). Cheap — callers can use this to
 * skip building expensive payloads when the logger is disabled.
 */
export function driftLogLevel() {
  return LEVEL;
}

