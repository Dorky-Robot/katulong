/**
 * Claude processor — refcounted per-UUID worker that tails a Claude transcript,
 * narrates new slices, and publishes the result to the topic broker.
 *
 * Lifecycle: one worker per watched UUID, started on the first `acquire()`
 * and torn down on the last `release()`. No daemon, no background tick when
 * nothing is subscribed — that's the point of refcounting.
 *
 * A worker loop looks like:
 *   1. Read the watchlist entry (gives us transcriptPath + lastProcessedLine).
 *   2. readTranscriptEntries(path, cursor, sliceLimit).
 *   3. narrateSlice(...) with the current rolling summary + objective.
 *   4. Publish each event to `claude/<uuid>` via the topic broker.
 *   5. watchlist.advance(uuid, nextCursor) — forward-only, only after success.
 *
 * If step 3 throws (Ollama down, network blip) we skip step 5 so the same
 * slice is retried on the next cycle. The summary and objective are kept in
 * memory for the life of the worker; they're cheap to rebuild on restart.
 *
 * Concurrency caps:
 *   - Per-worker: at most one narrate call in flight (`inFlight` flag).
 *   - Process-wide: `maxConcurrent` across all workers, so a busy multi-session
 *     host doesn't slam the local Ollama.
 *
 * See docs/claude-feed-watchlist.md for the overall design.
 */
import { readTranscriptEntries } from "./claude-event-transform.js";
import { narrateSlice } from "./claude-narrator.js";
import { log } from "./log.js";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SLICE_LIMIT = 50;

// When set, the processor still polls the transcript and advances the cursor
// but skips the Ollama round-trip entirely. Used while we rework the feed
// pipeline from multi-event narrative blocks to per-reply one-liner titles.
// Flip back to unset (or 0) to re-enable narration.
const OLLAMA_PAUSED = process.env.KATULONG_FEED_OLLAMA_PAUSE === "1";

/**
 * Build a Claude processor.
 *
 * @param {object} opts
 * @param {object} opts.watchlist      - { get, advance } — createWatchlist result
 * @param {object} opts.topicBroker    - { publish } — createTopicBroker result
 * @param {function} opts.callOllama   - async (userPrompt, { systemPrompt }) => string
 * @param {number} [opts.pollIntervalMs=2000]
 * @param {number} [opts.sliceLimit=50] - max significant lines per narrate cycle
 * @param {number} [opts.maxConcurrent=1] - global cap on in-flight Ollama calls
 * @param {string} [opts.topicPrefix="claude"]
 */
export function createClaudeProcessor({
  watchlist,
  topicBroker,
  callOllama,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sliceLimit = DEFAULT_SLICE_LIMIT,
  maxConcurrent = 1,
  topicPrefix = "claude",
}) {
  if (!watchlist) throw new Error("createClaudeProcessor: watchlist is required");
  if (!topicBroker) throw new Error("createClaudeProcessor: topicBroker is required");
  if (typeof callOllama !== "function") {
    throw new Error("createClaudeProcessor: callOllama is required");
  }

  const workers = new Map();
  // In-flight init promises keyed by uuid. A concurrent second `acquire` for
  // the same uuid must not race past the `workers.get` check while the first
  // caller is still awaiting `watchlist.get` — otherwise both create a worker
  // and the second overwrites the first, orphaning it. Any second caller sees
  // the pending promise here and awaits the completed worker.
  const pendingAcquires = new Map();
  let activeCalls = 0;
  let destroyed = false;

  function topicFor(uuid) {
    return `${topicPrefix}/${uuid}`;
  }

  function stopWorker(w) {
    if (w.stopped) return;
    w.stopped = true;
    if (w.timer) {
      clearTimeout(w.timer);
      w.timer = null;
    }
    workers.delete(w.uuid);
  }

  function scheduleNext(w, delay) {
    if (w.stopped || destroyed) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = null;
      tick(w);
    }, delay);
  }

  async function tick(w) {
    if (w.stopped || destroyed) return;

    // Per-worker guard: a cycle already in flight for this uuid will reschedule
    // itself on completion, so we just back off one poll interval.
    if (w.inFlight) {
      scheduleNext(w, pollIntervalMs);
      return;
    }

    // Global cap: if every narrate slot is busy, try again next poll.
    if (activeCalls >= maxConcurrent) {
      scheduleNext(w, pollIntervalMs);
      return;
    }

    w.inFlight = true;
    activeCalls += 1;
    let hasMore = false;
    try {
      hasMore = await runCycle(w);
    } catch (err) {
      log.warn("claude-processor: cycle failed", { uuid: w.uuid, error: err.message });
    } finally {
      activeCalls = Math.max(0, activeCalls - 1);
      w.inFlight = false;
      // Catch-up fast when there's more on disk; otherwise wait a poll.
      scheduleNext(w, hasMore ? 0 : pollIntervalMs);
    }
  }

  async function runCycle(w) {
    const entry = await watchlist.get(w.uuid);
    if (!entry) {
      // Removed from watchlist mid-run — worker stops. Refcount is left to the
      // caller; subsequent release() calls on a now-dead worker are no-ops.
      stopWorker(w);
      return false;
    }

    const { entries, nextCursor, hasMore } = readTranscriptEntries(
      entry.transcriptPath,
      entry.lastProcessedLine,
      sliceLimit,
    );

    // Nothing new read (cursor didn't move) — skip everything.
    if (nextCursor === entry.lastProcessedLine) return false;

    // Lines existed but all normalized to null (session metadata, /clear,
    // cancelled turns). Advance past them so we don't re-examine the same
    // junk every poll, and don't bother Ollama.
    if (entries.length === 0) {
      await watchlist.advance(w.uuid, nextCursor);
      return hasMore;
    }

    if (OLLAMA_PAUSED) {
      // Still advance the cursor so we don't accumulate an ever-growing
      // backlog. When we re-enable narration the user can explicitly reset
      // the cursor (via the watchlist) to reprocess from the top.
      await watchlist.advance(w.uuid, nextCursor);
      return hasMore;
    }

    const result = await narrateSlice({
      entries,
      summary: w.summary,
      objective: w.objective,
      callOllama,
    });

    for (const event of result.events) {
      topicBroker.publish(w.topic, JSON.stringify(event));
    }

    w.summary = result.summary;
    w.objective = result.objective;

    await watchlist.advance(w.uuid, nextCursor);
    return hasMore;
  }

  /**
   * Mark a UUID as actively watched. On the first caller we spin up a worker
   * and kick off an immediate narrate cycle so subscribers catch up instantly;
   * subsequent acquires just bump the refcount.
   *
   * Returns the new refcount. Throws if the UUID isn't on the watchlist
   * (callers must add it first — the processor doesn't opt things in).
   */
  async function acquire(uuid) {
    if (destroyed) throw new Error("createClaudeProcessor: destroyed");
    if (!uuid || typeof uuid !== "string") {
      throw new Error("acquire: uuid is required");
    }

    const existing = workers.get(uuid);
    if (existing) {
      existing.refcount += 1;
      return existing.refcount;
    }

    // Deduplicate concurrent first-time acquires for the same uuid. Without
    // this, two callers in the same event-loop turn both get past the
    // `workers.get` check, both await watchlist.get, and both try to create a
    // worker — orphaning the first one and leaving activeCalls permanently
    // bumped. The first caller records its in-flight promise here; any
    // second caller awaits it and bumps the shared worker's refcount.
    const pending = pendingAcquires.get(uuid);
    if (pending) {
      await pending;
      const w = workers.get(uuid);
      if (!w) throw new Error(`acquire: ${uuid} init failed`);
      w.refcount += 1;
      return w.refcount;
    }

    const initPromise = (async () => {
      const entry = await watchlist.get(uuid);
      if (!entry) {
        throw new Error(`acquire: ${uuid} is not on the watchlist`);
      }
      const w = {
        uuid,
        topic: topicFor(uuid),
        refcount: 1,
        timer: null,
        inFlight: false,
        stopped: false,
        summary: "",
        objective: "",
      };
      workers.set(uuid, w);
      // Kick off the first cycle immediately so the subscriber gets any backlog
      // without waiting a poll interval.
      scheduleNext(w, 0);
      return w;
    })();

    pendingAcquires.set(uuid, initPromise);
    try {
      const w = await initPromise;
      return w.refcount;
    } finally {
      pendingAcquires.delete(uuid);
    }
  }

  /**
   * Drop a reference. Returns the new refcount. When it reaches zero the
   * worker is torn down — no more polling, no more Ollama calls for this
   * UUID until someone acquires it again.
   */
  function release(uuid) {
    const w = workers.get(uuid);
    if (!w) return 0;
    w.refcount -= 1;
    if (w.refcount <= 0) {
      stopWorker(w);
      return 0;
    }
    return w.refcount;
  }

  /**
   * Stop every worker. Any in-flight narrate calls keep running to completion
   * (we don't try to abort them), but won't reschedule.
   */
  function destroy() {
    destroyed = true;
    for (const w of [...workers.values()]) stopWorker(w);
  }

  return {
    acquire,
    release,
    destroy,
    has: (uuid) => workers.has(uuid),
    refcount: (uuid) => (workers.get(uuid)?.refcount ?? 0),
  };
}
