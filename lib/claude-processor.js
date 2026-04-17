/**
 * Claude processor — refcounted per-UUID worker that tails a Claude
 * transcript and turns each assistant reply into a feed card.
 *
 * Lifecycle: one worker per watched UUID, started on the first `acquire()`
 * and torn down on the last `release()`. No daemon, no background tick
 * when nothing is subscribed — that's the point of refcounting.
 *
 * Each poll cycle:
 *   1. Read the watchlist entry (gives us transcriptPath + lastProcessedLine).
 *   2. readTranscriptEntries(path, cursor, sliceLimit).
 *   3. For every assistant entry with text in the slice, publish a "reply"
 *      event straight from the transcript — the reply card shows up in the
 *      feed immediately, stamped with the entry's own timestamp so it
 *      interleaves with other events in true chronological order.
 *   4. Fire a background Ollama call for each reply to generate a one-line
 *      title. When (if) it resolves, publish a "reply-title" enrichment
 *      event with the same entryId. The client keys reply items by entryId
 *      and swaps the default "Claude's reply (N words)" label for the
 *      Ollama-generated title.
 *   5. watchlist.advance(uuid, nextCursor) — forward-only. We advance even
 *      when Ollama is paused / down — the reply cards have already been
 *      published, and the title enrichment is optional progressive
 *      enhancement, not load-bearing.
 *
 * Why publish first and enrich later? Ollama is slow and sometimes down.
 * The feed should never wait on it — the raw Claude text is already the
 * content. The title is just a better collapsed-state label.
 *
 * Concurrency caps:
 *   - Per-worker: at most one cycle in flight (`inFlight` flag).
 *   - Process-wide: `maxConcurrent` background Ollama enrichments at once,
 *     so a multi-session host doesn't slam the local Ollama.
 *   - Background enrichments are tracked but do NOT block the polling
 *     loop — publishing the reply-title event is the terminal action.
 *
 * See docs/claude-feed-watchlist.md for the overall design.
 */
import { readTranscriptEntries } from "./claude-event-transform.js";
import { summarizeReply, extractFilesFromEntry } from "./claude-narrator.js";
import { log } from "./log.js";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SLICE_LIMIT = 50;

// When set, replies still publish immediately from the transcript but the
// Ollama title-enrichment call is skipped entirely. Cards render with the
// default "Claude's reply (N words)" label until Ollama is re-enabled.
// Useful when Ollama is down, slow, or under review.
const OLLAMA_PAUSED = process.env.KATULONG_FEED_OLLAMA_PAUSE === "1";

/**
 * Build a Claude processor.
 *
 * @param {object} opts
 * @param {object} opts.watchlist      - { get, advance } — createWatchlist result
 * @param {object} opts.topicBroker    - { publish } — createTopicBroker result
 * @param {function} opts.callOllama   - async (userPrompt, { systemPrompt }) => string
 * @param {number} [opts.pollIntervalMs=2000]
 * @param {number} [opts.sliceLimit=50] - max significant lines per poll cycle
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
  // Priority queue for Ollama enrichments. Processed newest-first (by
  // entry ts) so when the user opens a backlog of 600+ replies the most
  // contextually useful titles appear first. maxConcurrent throttles how
  // many calls to Ollama run at once — additional items wait in the queue
  // rather than getting dropped. Each item: { w, e } (worker + entry).
  const enrichmentQueue = [];
  let activeEnrichments = 0;
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
    // Drop queued enrichments for this worker so we don't spend Ollama
    // cycles on a UUID nobody is watching anymore. Already-in-flight calls
    // still return but their publish is swallowed by the `w.stopped` check.
    for (let i = enrichmentQueue.length - 1; i >= 0; i -= 1) {
      if (enrichmentQueue[i].w === w) enrichmentQueue.splice(i, 1);
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

    // Per-worker guard: a cycle already in flight for this uuid reschedules
    // itself when it finishes, so we just back off one poll interval.
    if (w.inFlight) {
      scheduleNext(w, pollIntervalMs);
      return;
    }

    w.inFlight = true;
    let hasMore = false;
    try {
      hasMore = await runCycle(w);
    } catch (err) {
      log.warn("claude-processor: cycle failed", { uuid: w.uuid, error: err.message });
    } finally {
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
    // junk every poll.
    if (entries.length === 0) {
      await watchlist.advance(w.uuid, nextCursor);
      return hasMore;
    }

    // Files touched since the last reply-with-text attach to the next
    // reply, not to the tool-only assistant entry that recorded them. In
    // Claude's transcript shape, one user turn can produce several
    // assistant entries — some with only tool_use blocks, some with the
    // final text — and the user intuits that the files belong to the
    // reply they're reading, not to an invisible mid-turn step.
    let pendingFiles = new Map();
    function mergeFiles(files) {
      for (const f of files) {
        if (!pendingFiles.has(f.path)) pendingFiles.set(f.path, f);
      }
    }

    for (const e of entries) {
      if (e.role !== "assistant") continue;
      mergeFiles(extractFilesFromEntry(e));
      if (!e.text) continue;

      const replyEvent = {
        status: "reply",
        entryId: e.uuid,
        step: e.text,
        ts: e.ts,
      };
      if (pendingFiles.size > 0) {
        replyEvent.files = [...pendingFiles.values()];
      }
      topicBroker.publish(w.topic, JSON.stringify(replyEvent), { timestamp: e.ts });
      pendingFiles = new Map();

      if (!OLLAMA_PAUSED) enqueueEnrichment(w, e);
    }

    await watchlist.advance(w.uuid, nextCursor);
    return hasMore;
  }

  // Insertion-sort the queue so the highest-ts entry is always at the end
  // (O(n) per push, but n is bounded by backlog size and typical usage is
  // a trickle). Drain pulls from the end. Keeping the newest at the tail
  // makes pop() O(1).
  function enqueueEnrichment(w, e) {
    let i = enrichmentQueue.length - 1;
    while (i >= 0 && enrichmentQueue[i].e.ts > e.ts) i -= 1;
    enrichmentQueue.splice(i + 1, 0, { w, e });
    drainEnrichmentQueue();
  }

  // Pull the newest queued entry and call Ollama. Respects maxConcurrent
  // by only firing while we're under the cap — every completion calls
  // back in to pick the next item. Because the queue is sorted ascending
  // by ts, the tail is always the newest unprocessed reply.
  function drainEnrichmentQueue() {
    while (!destroyed && activeEnrichments < maxConcurrent && enrichmentQueue.length > 0) {
      const next = enrichmentQueue.pop();
      if (!next) break;
      const { w, e } = next;
      if (w.stopped) continue;
      activeEnrichments += 1;
      (async () => {
        try {
          const title = await summarizeReply(e.text, callOllama);
          if (!title || w.stopped || destroyed) return;
          const titleEvent = {
            status: "reply-title",
            entryId: e.uuid,
            title,
          };
          topicBroker.publish(w.topic, JSON.stringify(titleEvent), { timestamp: e.ts });
        } catch (err) {
          log.warn("claude-processor: title enrichment failed", {
            uuid: w.uuid, entryId: e.uuid, error: err.message,
          });
        } finally {
          activeEnrichments = Math.max(0, activeEnrichments - 1);
          drainEnrichmentQueue();
        }
      })();
    }
  }

  /**
   * Mark a UUID as actively watched. On the first caller we spin up a worker
   * and kick off an immediate cycle so subscribers catch up instantly;
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
   * Stop every worker. Any in-flight enrichment calls keep running to
   * completion (we don't try to abort them), but their results are dropped
   * on the `w.stopped || destroyed` check so no stale events publish.
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
    // Test hooks — not for production callers.
    _workers: workers,
  };
}
