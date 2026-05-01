/**
 * Scrollback persistence store.
 *
 * Per-session terminal output history, written on graceful shutdown and
 * rehydrated on restore. Without this the in-memory RingBuffer dies with
 * the server process — a brief restart resets every client's `seq` cursor
 * arithmetic, and `pullFrom` for any pre-restart offset returns null
 * (treated as evicted) instead of the bytes the client missed.
 *
 * File layout: `<dataDir>/scrollback/<sessionId>` — one file per session,
 * keyed by the immutable surrogate id (lib/id.js). The body is a single
 * decimal cursor on the first line, then a newline, then the raw RingBuffer
 * contents verbatim:
 *
 *   1234567\n
 *   <escape sequences ...>
 *
 * The line-prefix format (vs JSON) avoids ~6× blow-up from JSON-encoding
 * 0x1B and other sub-0x20 bytes that fill terminal output. A 20 MB
 * RingBuffer JSON-encodes to ~120 MB; line-prefixed it's 20 MB plus a
 * short header.
 *
 * Writes are atomic (temp + rename, mode 0o600) so a crash mid-write
 * cannot leave a partial file that fails to parse on the next boot.
 * Files are owner-only because terminal output may contain sensitive
 * material echoed to the screen (passwords typed at non-noecho prompts,
 * tokens printed by tools, file contents).
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

const SCROLLBACK_SUBDIR = "scrollback";

// Defense in depth: ids are produced by lib/id.js (alnum, length 21) but
// adopted external tmux session names can also flow through here. The
// adopt path validates against /^[A-Za-z0-9_\-]+$/ with length ≤ 128;
// match that here so a hostile sessions.json cannot path-traverse out
// of the scrollback dir.
const VALID_ID = /^[A-Za-z0-9_-]+$/;

function isValidId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 128 && VALID_ID.test(id);
}

/**
 * Create a scrollback store bound to a data directory.
 *
 * @param {object} opts
 * @param {string|null} opts.dataDir - Parent dir. If null/empty, the store is
 *   a no-op (used by tests that don't want disk side effects).
 * @returns {{
 *   save: (sessionId: string, data: string, cursor: number) => void,
 *   load: (sessionId: string) => { data: string, cursor: number } | null,
 *   remove: (sessionId: string) => void,
 *   pruneExcept: (activeIds: Iterable<string>) => void,
 *   enabled: boolean,
 * }}
 */
export function createScrollbackStore({ dataDir }) {
  if (!dataDir) {
    return {
      save: () => {},
      load: () => null,
      remove: () => {},
      pruneExcept: () => {},
      enabled: false,
    };
  }

  const dir = join(dataDir, SCROLLBACK_SUBDIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    log.warn("Failed to create scrollback dir", { dir, error: err.message });
  }

  function pathFor(sessionId) {
    return join(dir, sessionId);
  }

  function save(sessionId, data, cursor) {
    if (!isValidId(sessionId)) return;
    if (typeof data !== "string") return;
    if (!Number.isFinite(cursor) || cursor < 0) return;
    // Cursor must be at least data.length — it's the byte position of the
    // last byte in `data`. A smaller value would imply we're claiming the
    // buffer ends before its own contents start, which load() rejects.
    if (cursor < data.length) return;

    const filePath = pathFor(sessionId);
    const tempPath = `${filePath}.tmp.${process.pid}`;
    try {
      writeFileSync(tempPath, `${cursor}\n${data}`, { encoding: "utf-8", mode: 0o600 });
      renameSync(tempPath, filePath);
    } catch (err) {
      log.warn("Failed to save scrollback", { sessionId, error: err.message });
      try { unlinkSync(tempPath); } catch { /* may not exist */ }
    }
  }

  function load(sessionId) {
    if (!isValidId(sessionId)) return null;
    let raw;
    try {
      raw = readFileSync(pathFor(sessionId), "utf-8");
    } catch {
      return null;
    }
    const nl = raw.indexOf("\n");
    if (nl < 0) return null;
    const cursor = Number(raw.slice(0, nl));
    if (!Number.isFinite(cursor) || cursor < 0 || !Number.isInteger(cursor)) return null;
    const data = raw.slice(nl + 1);
    // A file claiming cursor < data.length is structurally inconsistent —
    // either the header was truncated or the file was tampered with.
    // Refuse rather than restore a buffer with negative starting offset.
    if (cursor < data.length) return null;
    return { cursor, data };
  }

  function remove(sessionId) {
    if (!isValidId(sessionId)) return;
    try { unlinkSync(pathFor(sessionId)); } catch { /* missing is fine */ }
  }

  function pruneExcept(activeIds) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    const active = new Set(activeIds);
    for (const entry of entries) {
      if (active.has(entry)) continue;
      // Skip stray temp files (`.tmp.<pid>`) — they belong to a live or
      // crashed write and will be cleaned up by the next save() or by
      // the OS over time. Removing them here would race a concurrent
      // shutdown writer.
      if (entry.includes(".tmp.")) continue;
      try { unlinkSync(join(dir, entry)); } catch { /* concurrent unlink */ }
    }
  }

  return { save, load, remove, pruneExcept, enabled: true };
}
