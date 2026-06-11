/**
 * Session persistence store.
 *
 * Owns the sessions.json file on disk. Exposes a debounced `scheduleSave()`
 * so rapid session-map mutations collapse into a single write, a synchronous
 * `saveNow()` for shutdown, and `load()` for restore.
 *
 * The store is generic: it does not know what a "session" is. The caller
 * provides a `serialize()` callback that returns a plain object to persist.
 * This keeps the persistence concern independent of the session-manager's
 * internal Session class and transport bridge.
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Create a session store bound to a directory.
 *
 * @param {object} opts
 * @param {string|null} opts.dataDir - Directory for sessions.json. If null, the
 *   store is a no-op (useful for tests).
 * @param {() => object} opts.serialize - Returns the object to persist.
 * @param {number} [opts.debounceMs=100] - Debounce window for scheduleSave.
 * @returns {{ scheduleSave: () => void, saveNow: () => void, load: () => object | null, cancelPendingSave: () => void }}
 */
export function createSessionStore({ dataDir, serialize, debounceMs = DEFAULT_DEBOUNCE_MS }) {
  const path = dataDir ? join(dataDir, "sessions.json") : null;
  let saveTimer = null;

  function saveNow() {
    if (!path) return;
    try {
      // Atomic write (temp + rename) — a crash mid-write must not leave a
      // truncated sessions.json, or every session would silently fail to
      // restore on the next boot. Same pattern as auth state and
      // scrollback-store.
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(serialize(), null, 2), "utf-8");
      renameSync(tmp, path);
    } catch (err) {
      log.warn("Failed to save sessions.json", { error: err.message });
    }
  }

  function cancelPendingSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function scheduleSave() {
    if (!path) return;
    cancelPendingSave();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, debounceMs);
    if (saveTimer.unref) saveTimer.unref();
  }

  function load() {
    if (!path) return null;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed;
    } catch (err) {
      // ENOENT is the normal first-boot case. Anything else (EACCES, EIO,
      // corrupt JSON) means persisted sessions exist but can't be restored —
      // the operator needs to see that, not a silent empty session list.
      if (err.code !== "ENOENT") {
        log.warn("Failed to load sessions.json — starting without restored sessions", {
          path, error: err.message,
        });
      }
      return null;
    }
  }

  return { scheduleSave, saveNow, load, cancelPendingSave };
}
