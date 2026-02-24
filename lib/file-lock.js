import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import envConfig from "./env-config.js";

const DATA_DIR = envConfig.dataDir;
const DEFAULT_LOCK_PATH = join(DATA_DIR, "katulong-auth.lock");
const STALE_TIMEOUT_MS = 10000; // 10 seconds — consider lock stale after this

/**
 * Acquire a cross-process file lock using mkdirSync (atomic on all platforms).
 * Spins with increasing delay until timeout. Detects and breaks stale locks.
 *
 * @param {string} [lockPath] — path to the lock directory
 * @param {number} [timeoutMs=5000] — max time to wait for lock
 * @returns {boolean} true if lock was acquired
 */
export function acquireFileLock(lockPath = DEFAULT_LOCK_PATH, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 5; // start at 5ms

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      // Check for stale lock
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_TIMEOUT_MS) {
          // Stale lock — break it
          try { rmdirSync(lockPath); } catch { /* another process may have already removed it */ }
          continue; // retry immediately
        }
      } catch {
        // Lock dir disappeared between EEXIST and stat — retry
        continue;
      }

      // Wait and retry with exponential backoff (capped at 50ms)
      const waitUntil = Date.now() + delay;
      while (Date.now() < waitUntil) { /* spin */ }
      delay = Math.min(delay * 2, 50);
    }
  }

  return false; // timed out
}

/**
 * Release a cross-process file lock.
 *
 * @param {string} [lockPath] — path to the lock directory
 */
export function releaseFileLock(lockPath = DEFAULT_LOCK_PATH) {
  try {
    rmdirSync(lockPath);
  } catch {
    // Lock may already be removed (e.g. broken by stale detection)
  }
}
