/**
 * Session summary persistence store.
 *
 * Per-session append-only history of `{ title, summary, at }` records
 * produced by the summarizer. Lives on disk so it survives server
 * restarts, and lives outside `session.meta` so it cannot pressure the
 * 4 KB meta cap (which previously caused every `setMeta` call to fail
 * once a session had ~12 summary entries — including the pane monitor's
 * meta.pane writes, killing the status pill bar).
 *
 * File layout: `<dataDir>/summaries/<sessionId>.jsonl` — one JSON record
 * per line, oldest→newest. A rotated generation lives next to it as
 * `<sessionId>.jsonl.old` so a session that crosses the rotation cap
 * still shows older context until it cycles out.
 *
 * Why JSONL: append is one `appendFileSync` per cycle, no read-modify-
 * write window, naturally durable to mid-write crash (worst case: a
 * partial trailing line that the parser drops). Rotation is a `rename`
 * (atomic on POSIX), so a reader that interleaves with a rotation sees
 * either the pre- or post-rotation file but never a mid-state.
 *
 * Concurrency: each entry serializes to a few hundred bytes, well under
 * the POSIX PIPE_BUF (4096 B), so an `appendFileSync(O_APPEND)` is atomic
 * with respect to other writers in this process and across processes.
 * Two writers racing on the rotation threshold can both decide to rotate;
 * the second rename just overwrites the first's `.old`, which is benign
 * (one extra rotation, not data loss beyond what the cap already implies).
 *
 * Files are owner-only (0o600) because summaries can include excerpts of
 * terminal output (filenames, branch names, sometimes full commands).
 */

import {
  mkdirSync, chmodSync, appendFileSync, readFileSync, renameSync,
  unlinkSync, readdirSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

const SUMMARIES_SUBDIR = "summaries";

// Per-session size cap. When a file crosses this on append, we rotate
// it to `.jsonl.old` and start a fresh primary. Two generations means a
// session keeps roughly 2× this worth of recent history available; older
// entries age out as new ones land. 256 KB ≈ ~1000 entries at the typical
// 250 B per record, which is far more "what was I doing" context than any
// user actually scrolls back through.
const ROTATE_BYTES = 256 * 1024;

// Hard read ceiling — refuse to slurp anything pathologically large into
// memory. Two generations × ROTATE_BYTES is the legitimate maximum, plus
// a slack for the final entry that crossed the threshold.
const MAX_FILE_BYTES = ROTATE_BYTES * 2;

// Match scrollback-store's id format. Same threat model: a hostile
// sessions.json or adopted tmux session name must not path-traverse out
// of the summaries dir.
const VALID_ID = /^[A-Za-z0-9_-]+$/;

function isValidId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 128 && VALID_ID.test(id);
}

function isValidEntry(e) {
  return e
    && typeof e.title === "string"
    && typeof e.summary === "string"
    && Number.isFinite(e.at);
}

/**
 * Create a summary store bound to a data directory.
 *
 * @param {object} opts
 * @param {string|null} opts.dataDir - Parent dir. If null/empty, the store is
 *   a no-op (used by tests that don't want disk side effects).
 * @returns {{
 *   append: (sessionId: string, entry: { title: string, summary: string, at: number }) => void,
 *   read: (sessionId: string, opts?: { limit?: number }) => Array<{ title: string, summary: string, at: number }>,
 *   migrate: (sessionId: string, entries: Array<object>) => void,
 *   remove: (sessionId: string) => void,
 *   pruneExcept: (activeIds: Iterable<string>) => void,
 * }}
 */
export function createSummaryStore({ dataDir }) {
  if (!dataDir) {
    return {
      append: () => {},
      read: () => [],
      migrate: () => {},
      remove: () => {},
      pruneExcept: () => {},
    };
  }

  const dir = join(dataDir, SUMMARIES_SUBDIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* readonly volume etc. */ }
  } catch (err) {
    log.warn("Failed to create summaries dir", { dir, error: err.message });
  }

  function pathFor(sessionId) {
    return join(dir, `${sessionId}.jsonl`);
  }

  function oldPathFor(sessionId) {
    return join(dir, `${sessionId}.jsonl.old`);
  }

  function rotateIfNeeded(filePath, oldPath) {
    let size = 0;
    try { size = statSync(filePath).size; } catch { return; }
    if (size < ROTATE_BYTES) return;
    try {
      renameSync(filePath, oldPath);
    } catch (err) {
      log.warn("Failed to rotate summary file", { filePath, error: err.message });
    }
  }

  function append(sessionId, entry) {
    if (!isValidId(sessionId) || !isValidEntry(entry)) return;
    const filePath = pathFor(sessionId);
    const line = JSON.stringify({
      title: entry.title,
      summary: entry.summary,
      at: entry.at,
    }) + "\n";
    try {
      appendFileSync(filePath, line, { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      log.warn("Failed to append summary entry", { sessionId, error: err.message });
      return;
    }
    rotateIfNeeded(filePath, oldPathFor(sessionId));
  }

  function readFile(filePath) {
    let stat;
    try { stat = statSync(filePath); } catch { return []; }
    if (stat.size > MAX_FILE_BYTES) {
      log.warn("Summary file exceeds size limit, ignoring", {
        filePath, size: stat.size, limit: MAX_FILE_BYTES,
      });
      return [];
    }
    let raw;
    try { raw = readFileSync(filePath, "utf-8"); } catch { return []; }
    const out = [];
    // Split on newlines and silently drop unparseable / partial trailing
    // lines. A crash mid-write may leave one truncated record at the tail;
    // the rest of the history is still useful, so we don't fail the read.
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (isValidEntry(e)) out.push(e);
      } catch { /* drop unparseable line */ }
    }
    return out;
  }

  function read(sessionId, { limit } = {}) {
    if (!isValidId(sessionId)) return [];
    // Concatenate rotated → primary so the caller sees a continuous
    // oldest-to-newest stream across the rotation boundary. The .old file
    // is always older than the primary because rotation is rename.
    const all = [...readFile(oldPathFor(sessionId)), ...readFile(pathFor(sessionId))];
    if (Number.isFinite(limit) && limit > 0 && all.length > limit) {
      return all.slice(all.length - limit);
    }
    return all;
  }

  function migrate(sessionId, entries) {
    if (!isValidId(sessionId)) return;
    if (!Array.isArray(entries) || entries.length === 0) return;
    // Single appendFileSync of the whole batch is faster than N individual
    // appends and atomically lands as one block — no risk of a half-migrated
    // session if the process dies mid-loop. Validate per-entry so a single
    // bad legacy record can't poison the whole batch.
    const lines = entries
      .filter(isValidEntry)
      .map((e) => JSON.stringify({ title: e.title, summary: e.summary, at: e.at }))
      .join("\n");
    if (!lines) return;
    try {
      appendFileSync(pathFor(sessionId), lines + "\n", { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      log.warn("Failed to migrate summary history", { sessionId, error: err.message });
      return;
    }
    rotateIfNeeded(pathFor(sessionId), oldPathFor(sessionId));
  }

  function remove(sessionId) {
    if (!isValidId(sessionId)) return;
    try { unlinkSync(pathFor(sessionId)); } catch { /* missing is fine */ }
    try { unlinkSync(oldPathFor(sessionId)); } catch { /* missing is fine */ }
  }

  function pruneExcept(activeIds) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    const active = new Set(activeIds);
    for (const entry of entries) {
      // Strip both possible suffixes to recover the session id.
      let id = null;
      if (entry.endsWith(".jsonl")) id = entry.slice(0, -".jsonl".length);
      else if (entry.endsWith(".jsonl.old")) id = entry.slice(0, -".jsonl.old".length);
      else continue;
      if (!isValidId(id)) continue;
      if (active.has(id)) continue;
      try { unlinkSync(join(dir, entry)); } catch { /* concurrent unlink */ }
    }
  }

  return { append, read, migrate, remove, pruneExcept };
}
