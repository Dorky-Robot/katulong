/**
 * Claude feed watchlist — opt-in ledger of Claude UUIDs to narrate.
 *
 * One durable file at `<dataDir>/claude-watchlist.json`, shape:
 *
 *   {
 *     "<uuid>": {
 *       "addedAt":           <ms since epoch>,
 *       "transcriptPath":    "<absolute path to ~/.claude/projects/.../uuid.jsonl>",
 *       "lastProcessedLine": <integer cursor into the transcript>
 *     }
 *   }
 *
 * Presence of an entry = narration is allowed. Absence = ignore this UUID
 * even if its transcript exists on disk. The cursor advances only after
 * a successful publish of events derived from those lines. Writes are
 * serialized through an in-process mutex (so a sparkle-click during a
 * cursor advance cannot clobber it) and committed via temp+rename so a
 * crash never leaves half-written JSON on disk.
 *
 * See docs/claude-feed-watchlist.md for the full design.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "./log.js";

const FILENAME = "claude-watchlist.json";

function readWatchlist(filePath) {
  if (!existsSync(filePath)) return {};
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    log.warn("claude-watchlist: read failed — treating as empty", { error: err.message });
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    log.warn("claude-watchlist: corrupt JSON — treating as empty", { error: err.message });
    return {};
  }
}

function writeWatchlist(filePath, entries) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(entries, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tempPath, filePath);
}

/**
 * Build a watchlist store rooted at `<dataDir>/claude-watchlist.json`.
 *
 * Callers get:
 *   add(uuid, { transcriptPath })  - idempotent; re-adding a uuid keeps
 *                                     its existing cursor (resume, not replay).
 *   remove(uuid)                   - drops the entry; topic log is untouched.
 *   advance(uuid, lineCount)       - moves the cursor forward-only.
 *   get(uuid)                      - snapshot of one entry (or null).
 *   list()                         - snapshot of all entries.
 *
 * All mutators serialize through one promise chain so concurrent callers
 * can't race. Reads run within the same chain so they observe the
 * latest committed state.
 */
export function createWatchlist({ dataDir }) {
  if (!dataDir) throw new Error("createWatchlist: dataDir is required");
  const filePath = join(dataDir, FILENAME);

  let chain = Promise.resolve();

  function serialize(op) {
    const next = chain.then(op);
    // Swallow failures in the chain so one bad op doesn't poison the queue.
    // Errors still surface to the caller via the returned promise.
    chain = next.catch(() => {});
    return next;
  }

  return {
    list() {
      return serialize(() => ({ ...readWatchlist(filePath) }));
    },

    get(uuid) {
      return serialize(() => {
        const all = readWatchlist(filePath);
        return all[uuid] ? { ...all[uuid] } : null;
      });
    },

    add(uuid, { transcriptPath }) {
      if (!uuid || typeof uuid !== "string") throw new Error("add: uuid required");
      if (!transcriptPath) throw new Error("add: transcriptPath required");
      return serialize(() => {
        const all = readWatchlist(filePath);
        if (all[uuid]) {
          // Idempotent: preserve cursor, refresh transcriptPath in case it moved.
          all[uuid] = { ...all[uuid], transcriptPath };
        } else {
          all[uuid] = {
            addedAt: Date.now(),
            transcriptPath,
            lastProcessedLine: 0,
          };
        }
        writeWatchlist(filePath, all);
        return { ...all[uuid] };
      });
    },

    remove(uuid) {
      return serialize(() => {
        const all = readWatchlist(filePath);
        if (!all[uuid]) return false;
        delete all[uuid];
        writeWatchlist(filePath, all);
        return true;
      });
    },

    advance(uuid, lineCount) {
      if (!Number.isInteger(lineCount) || lineCount < 0) {
        throw new Error("advance: lineCount must be a non-negative integer");
      }
      return serialize(() => {
        const all = readWatchlist(filePath);
        const entry = all[uuid];
        if (!entry) return null;
        // Forward-only. A stale advance (e.g. from a retry that lost the race
        // with a newer publish) is silently ignored rather than rewinding.
        if (lineCount <= entry.lastProcessedLine) return { ...entry };
        all[uuid] = { ...entry, lastProcessedLine: lineCount };
        writeWatchlist(filePath, all);
        return { ...all[uuid] };
      });
    },
  };
}
