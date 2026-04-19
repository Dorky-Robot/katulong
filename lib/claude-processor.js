/**
 * Claude processor — one per-UUID worker that tails a Claude transcript
 * and turns each assistant reply into a feed card.
 *
 * Lifecycle: one worker per watched UUID. Workers start the moment the
 * UUID appears on the watchlist (either from a fresh `acquire()` or
 * from the boot-time scan) and keep polling for as long as the UUID
 * stays on the watchlist. They stop only when the watchlist removes
 * the entry or the processor is destroyed.
 *
 * The refcount still matters — it just drives *poll rate*, not worker
 * existence. With subscribers (refcount > 0) the worker polls every
 * `pollIntervalMs`; idle (refcount 0) it backs off to
 * `idlePollIntervalMs` so the cursor keeps advancing without burning
 * CPU on a transcript nobody is watching. Previous versions tore the
 * worker down on refcount 0 and relied on the next subscriber to
 * re-attach — but any disconnect (page refresh, brief network blip,
 * server respawn) froze the cursor, and reconnections showed a stale
 * feed frozen at the last seq from the previous subscriber. Running a
 * cheap idle poll decouples the two.
 *
 * Each poll cycle:
 *   1. Read the watchlist entry (gives us transcriptPath + lastProcessedLine).
 *   2. readTranscriptEntries(path, cursor, sliceLimit).
 *   3. For every assistant entry with text, publish a `reply` event
 *      straight from the transcript — stamped with the entry's own
 *      timestamp so the feed sorts by when Claude actually said it.
 *      Files touched by earlier tool-only assistant entries in the same
 *      turn are bundled onto the reply as `files[]` so the UI can render
 *      clickable chips alongside the prose.
 *   4. watchlist.advance(uuid, nextCursor) — forward-only.
 *
 * See docs/claude-feed-watchlist.md for the overall design.
 */
import { readTranscriptEntries } from "./claude-event-transform.js";
import { extractFilesFromEntry, summarizeSession } from "./claude-narrator.js";
import { log } from "./log.js";

const DEFAULT_POLL_INTERVAL_MS = 2000;
// Back-off used when no subscriber is attached. 15s is the sweet spot:
// fast enough that a user who opens the feed after claude has been
// typing for a while sees near-current state (worst case: one 15s
// window of lag, caught up in one fast cycle once subscribed), slow
// enough that a dozen idle workers cost effectively nothing.
const DEFAULT_IDLE_POLL_INTERVAL_MS = 15000;
const DEFAULT_SLICE_LIMIT = 50;
// How many most-recent transcript lines to feed the summarizer each
// cycle. The previous summary carries older context, so this tail can
// stay tight — tested at 60 and qwen2.5-coder:7b timed out at 60s on
// an overloaded host. Keep it small: the model only needs to see what
// has changed since the last summary.
const SUMMARY_CONTEXT_LIMIT = 20;

/**
 * Build a Claude processor.
 *
 * @param {object} opts
 * @param {object} opts.watchlist      - { get, advance } — createWatchlist result
 * @param {object} opts.topicBroker    - { publish, setMeta } — createTopicBroker result
 * @param {function} [opts.callOllama] - async (userPrompt, { systemPrompt }) => string.
 *                                       Optional — when omitted or when a call throws,
 *                                       summary generation is skipped silently.
 * @param {function} [opts.onSummary]  - `(uuid, summary) => void` callback fired
 *                                       after each successful summary. The processor
 *                                       stays layer-pure; the caller (server.js)
 *                                       decides whether to mirror the summary onto
 *                                       a session's meta.claude.summary. Swallowed
 *                                       if the callback throws.
 * @param {number} [opts.pollIntervalMs=2000]
 * @param {number} [opts.idlePollIntervalMs=15000] - poll cadence when no
 *        subscribers are attached. Workers keep running at this slower
 *        rate so the cursor never freezes across subscriber gaps.
 * @param {number} [opts.sliceLimit=50] - max significant lines per poll cycle
 * @param {string} [opts.topicPrefix="claude"]
 */
export function createClaudeProcessor({
  watchlist,
  topicBroker,
  callOllama = null,
  onSummary = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  idlePollIntervalMs = DEFAULT_IDLE_POLL_INTERVAL_MS,
  sliceLimit = DEFAULT_SLICE_LIMIT,
  topicPrefix = "claude",
}) {
  if (!watchlist) throw new Error("createClaudeProcessor: watchlist is required");
  if (!topicBroker) throw new Error("createClaudeProcessor: topicBroker is required");

  const workers = new Map();
  // In-flight init promises keyed by uuid. A concurrent second `acquire` for
  // the same uuid must not race past the `workers.get` check while the first
  // caller is still awaiting `watchlist.get` — otherwise both create a worker
  // and the second overwrites the first, orphaning it. Any second caller sees
  // the pending promise here and awaits the completed worker.
  const pendingAcquires = new Map();
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

  // Fast when someone is watching, idle otherwise. The worker keeps
  // running at the idle cadence so the cursor advances even while no
  // SSE client is attached — reconnects then show up-to-date state
  // instead of a frozen feed pinned to wherever the last subscriber
  // left off.
  function nextInterval(w) {
    return w.refcount > 0 ? pollIntervalMs : idlePollIntervalMs;
  }

  async function tick(w) {
    if (w.stopped || destroyed) return;

    // Per-worker guard: a cycle already in flight for this uuid reschedules
    // itself when it finishes, so we just back off one poll interval.
    if (w.inFlight) {
      scheduleNext(w, nextInterval(w));
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
      // Catch-up fast when there's more on disk; otherwise use the
      // subscriber-aware interval (fast when watched, idle otherwise).
      scheduleNext(w, hasMore ? 0 : nextInterval(w));
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
    //
    // The accumulator lives on the WORKER (w.pendingFiles), not inside
    // runCycle. That's load-bearing: a catch-up through a big backlog
    // chunks the transcript into sliceLimit-sized reads. If pendingFiles
    // reset per cycle, any turn that straddled a slice boundary would
    // lose its tool_use entries — the tool-only assistant entries landed
    // in slice N, the final text reply landed in slice N+1, and the
    // reply was published with no files[]. That's exactly the "file
    // chips show inconsistently" symptom.
    if (!w.pendingFiles) w.pendingFiles = new Map();
    function mergeFiles(files) {
      for (const f of files) {
        if (!w.pendingFiles.has(f.path)) w.pendingFiles.set(f.path, f);
      }
    }

    let publishedAny = false;
    for (const e of entries) {
      // User prompts get their own feed event so the reader can see the
      // conversation flow, not just Claude's half. `tool_result` entries
      // (Claude Code synthesizes these as role:"user" transcript lines)
      // have their own normalized role and are skipped — they're
      // invisible plumbing, not something the user typed.
      //
      // A new user prompt also resets the file accumulator: whatever
      // tool-touched files were waiting belonged to the PREVIOUS turn
      // and will never be claimed by a reply now that the user spoke
      // again. Dropping them keeps us from sticking stale chips on the
      // next assistant turn.
      if (e.role === "user" && e.text) {
        w.pendingFiles = new Map();
        const promptEvent = {
          status: "prompt",
          entryId: e.uuid,
          step: e.text,
          ts: e.ts,
        };
        topicBroker.publish(w.topic, JSON.stringify(promptEvent), { timestamp: e.ts });
        publishedAny = true;
        continue;
      }

      if (e.role !== "assistant") continue;
      mergeFiles(extractFilesFromEntry(e));
      if (!e.text) continue;

      const replyEvent = {
        status: "reply",
        entryId: e.uuid,
        step: e.text,
        ts: e.ts,
      };
      if (w.pendingFiles.size > 0) {
        replyEvent.files = [...w.pendingFiles.values()];
      }
      topicBroker.publish(w.topic, JSON.stringify(replyEvent), { timestamp: e.ts });
      w.pendingFiles = new Map();
      publishedAny = true;
    }

    await watchlist.advance(w.uuid, nextCursor);
    if (publishedAny) scheduleSummary(w, entry.transcriptPath);
    return hasMore;
  }

  // Fire a summary generation in the background. Kept fire-and-forget
  // so the polling loop never blocks on Ollama; if one is already
  // running for this worker we skip (the next cycle will pick up the
  // newest state anyway). If callOllama isn't wired, we no-op.
  function scheduleSummary(w, transcriptPath) {
    if (!callOllama || w.summaryInFlight) return;
    w.summaryInFlight = true;
    (async () => {
      try {
        // Read a wider window than the cycle slice so the summary has
        // context even when a single cycle only carried a turn or two.
        // `fromLine: 0` is cheap — readTranscriptEntries skims the file
        // once and we only ever keep the tail.
        const { entries } = readTranscriptEntries(transcriptPath, 0);
        const tail = entries.slice(-SUMMARY_CONTEXT_LIMIT);
        const transcript = formatForSummary(tail);
        if (!transcript) return;

        const result = await summarizeSession({
          transcript,
          previous: w.summary,
          callOllama,
        });
        if (!result || w.stopped || destroyed) return;

        w.summary = result;

        const summaryEvent = {
          status: "session-summary",
          short: result.short,
          long: result.long,
          updatedAt: Date.now(),
        };
        topicBroker.publish(w.topic, JSON.stringify(summaryEvent));

        // Store on the topic so a fresh subscriber can pull it out-of-
        // band (some surfaces don't want to wait for the whole log
        // replay to pick a summary off the end).
        try {
          topicBroker.setMeta?.(w.topic, { summary: result });
        } catch (err) {
          log.warn("claude-processor: setMeta summary failed", { uuid: w.uuid, error: err.message });
        }

        // Let the host wire the summary into anywhere outside the
        // processor's layer — e.g. mirroring it onto the matching
        // tmux session's meta.claude.summary so the tab tooltip can
        // pick it up. The processor itself stays layer-pure.
        if (typeof onSummary === "function") {
          try {
            onSummary(w.uuid, result);
          } catch (err) {
            log.warn("claude-processor: onSummary callback failed", { uuid: w.uuid, error: err.message });
          }
        }
      } catch (err) {
        log.warn("claude-processor: summary failed", { uuid: w.uuid, error: err.message });
      } finally {
        w.summaryInFlight = false;
      }
    })();
  }

  // Condense normalized transcript entries into a short prose block
  // the summarizer can read without wading through JSON shapes. Tool
  // results are kept brief — they're noisy and the model doesn't need
  // the full stdout to describe the arc.
  function formatForSummary(entries) {
    const out = [];
    for (const e of entries) {
      if (e.role === "user" && e.text) out.push(`User: ${truncateForSummary(e.text, 300)}`);
      else if (e.role === "assistant" && e.text) out.push(`Claude: ${truncateForSummary(e.text, 400)}`);
      else if (e.role === "tool_result" && e.text) out.push(`Tool result: ${truncateForSummary(e.text, 120)}`);
    }
    return out.join("\n\n");
  }
  function truncateForSummary(s, max) {
    if (s.length <= max) return s;
    return s.slice(0, max - 1).trimEnd() + "…";
  }

  /**
   * Mark a UUID as actively watched. If no worker exists yet we create
   * one; if the worker was idling (refcount 0) we kick an immediate
   * cycle so the caller sees current state without waiting for the next
   * idle tick. Otherwise we just bump the refcount.
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
      const wasIdle = existing.refcount === 0;
      existing.refcount += 1;
      // 0→1 transition: jump to fast cadence immediately. Without this
      // a subscriber reconnecting mid-idle-window would wait up to
      // `idlePollIntervalMs` for the next tick before seeing new
      // entries — the whole point of this decoupling is that reconnect
      // feels instant.
      if (wasIdle) scheduleNext(existing, 0);
      return existing.refcount;
    }

    const pending = pendingAcquires.get(uuid);
    if (pending) {
      await pending;
      const w = workers.get(uuid);
      if (!w) throw new Error(`acquire: ${uuid} init failed`);
      const wasIdle = w.refcount === 0;
      w.refcount += 1;
      if (wasIdle) scheduleNext(w, 0);
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

  // Drop one subscriber. At refcount 0 the worker does NOT stop — it
  // falls back to idle polling so the cursor keeps advancing and the
  // next subscriber sees current state. Workers only stop when the
  // watchlist entry is removed (see runCycle) or destroy() is called.
  function release(uuid) {
    const w = workers.get(uuid);
    if (!w) return 0;
    if (w.refcount > 0) w.refcount -= 1;
    if (w.refcount === 0) scheduleNext(w, idlePollIntervalMs);
    return w.refcount;
  }

  function destroy() {
    destroyed = true;
    for (const w of [...workers.values()]) stopWorker(w);
  }

  // Boot-time spawn: every UUID already on the watchlist gets a worker
  // at refcount 0 (idle poll). Without this, a server restart leaves
  // watchlist entries orphaned until somebody opens a feed tile — the
  // feed sits frozen at whatever seq the topic log ended on before the
  // restart, even though the transcript has moved on.
  //
  // Fire-and-forget: any error here just warns. The processor is still
  // usable; acquire() will lazily spawn workers for UUIDs the boot
  // scan missed. We also guard against racing with an acquire() that
  // landed before the scan completed.
  const bootSpawn = (async () => {
    try {
      const all = await watchlist.list();
      const uuids = Object.keys(all || {});
      if (uuids.length > 0) {
        log.info("claude-processor: boot-spawning workers", { count: uuids.length });
      }
      for (const uuid of uuids) {
        if (destroyed) return;
        if (workers.has(uuid) || pendingAcquires.has(uuid)) continue;
        const w = {
          uuid,
          topic: topicFor(uuid),
          refcount: 0,
          timer: null,
          inFlight: false,
          stopped: false,
        };
        workers.set(uuid, w);
        scheduleNext(w, 0);
      }
    } catch (err) {
      log.warn("claude-processor: boot-spawn failed", { error: err.message });
    }
  })();

  return {
    acquire,
    release,
    destroy,
    has: (uuid) => workers.has(uuid),
    refcount: (uuid) => (workers.get(uuid)?.refcount ?? 0),
    ready: () => bootSpawn,
    _workers: workers,
  };
}
