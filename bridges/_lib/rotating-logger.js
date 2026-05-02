/**
 * Per-week rotating JSON-line logger for bridges.
 *
 * Writes events as one JSON object per line into `<dir>/<YYYY-MM-DD>.log`,
 * where the date is the UTC Sunday that begins the entry's week.
 *
 * UTC was chosen for the filename — not local time — so it matches the
 * `ts` field inside each line (UTC ISO). Opening `2026-04-26.log` shows a
 * clean [Sun 00:00Z, next-Sun 00:00Z) window with no mental TZ conversion
 * at grep time.
 *
 * The logger is synchronous (`appendFileSync`) on purpose: bridge log
 * volume is low (handful of events per minute), and a sync append makes
 * the contract dead simple — by the time `logger(event)` returns, the
 * line is on disk. No stream lifecycle, no flush dance, no async handle
 * to leak across rotation. The default console.warn logger this replaces
 * is also synchronous.
 *
 * The logger never throws into the caller. On a write failure (disk
 * full, EACCES, parent path is a regular file) the line is sent to
 * `process.stderr` as a fallback so a logging failure can't break the
 * bridge's request path.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * UTC-Sunday-of-the-week as `YYYY-MM-DD`. Weeks start on Sunday.
 *
 *   2026-05-03 (Sun, UTC)   → "2026-05-03"
 *   2026-05-01 (Fri, UTC)   → "2026-04-26"
 *   2027-01-01 (Fri, UTC)   → "2026-12-27"  (year boundary)
 */
export function sundayOfWeekUTC(date) {
  const sunday = new Date(date.getTime());
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  sunday.setUTCHours(0, 0, 0, 0);
  return sunday.toISOString().slice(0, 10);
}

export function createRotatingLogger({ dir, now = () => new Date() } = {}) {
  const logger = (event) => {
    const ts = now();
    const line = JSON.stringify({ ts: ts.toISOString(), ...event }) + "\n";
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${sundayOfWeekUTC(ts)}.log`), line, { mode: 0o644 });
    } catch {
      try { process.stderr.write(line); } catch { /* nothing left to do */ }
    }
  };
  // No-op kept for API symmetry — earlier stream-based draft exposed
  // close(), and tests + future callers may rely on it being callable.
  logger.close = () => {};
  return logger;
}
