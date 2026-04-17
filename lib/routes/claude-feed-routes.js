/**
 * Claude feed HTTP routes.
 *
 * Four small endpoints wire the watchlist + processor into the UI:
 *
 *   POST   /api/claude/watch         — opt a UUID in (the sparkle-click path)
 *   DELETE /api/claude/watch/:uuid   — opt back out
 *   GET    /api/claude/watchlist     — list watched UUIDs + cursors
 *   GET    /api/claude/stream/:uuid  — SSE; acquires a processor ref while open
 *
 * Only /stream refcounts the processor. Watch/unwatch are pure watchlist
 * mutations — they don't start or stop narration on their own. Narration
 * only runs while someone has an open SSE stream.
 *
 * The /stream endpoint is Claude-specific by design (not just /sub/:topic)
 * because subscribing implies "keep narrating this for me" — a concern that
 * doesn't belong on the generic topic broker.
 *
 * UUID resolution: the watch endpoint requires an explicit `{ uuid, cwd }`.
 * Earlier iterations tried two heuristics — an mtime scan over
 * ~/.claude/projects/<slug>/ and live-process lsof inspection of the pane's
 * claude PID — both picked the wrong transcript in common cases. Claude Code
 * keeps multiple JSONLs open during startup (compaction context), and the
 * filesystem doesn't know which session is "yours". The only reliable signal
 * is the SessionStart hook, which stamps `meta.claude.uuid` on the session.
 * If the client sends `{ session }` without a uuid we tell them to install
 * the hook — see `katulong setup claude-hooks`.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { UUID_RE } from "../claude-event-transform.js";
import { slugifyCwd } from "../claude-transcript-discovery.js";

/**
 * Build a { uuid, transcriptPath } target from an explicit { uuid, cwd }
 * body. This is the only supported shape — the frontend must already know
 * the uuid (populated into `meta.claude.uuid` by the SessionStart hook).
 *
 * Returns `{ uuid, transcriptPath }` on success or `{ error }` on failure.
 */
export function resolveWatchTarget({ body, homeDir }) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const uuid = typeof body.uuid === "string" ? body.uuid : null;
  const cwd = typeof body.cwd === "string" ? body.cwd : null;

  if (!uuid || !cwd) {
    return { error: "Provide { uuid, cwd }" };
  }
  if (!UUID_RE.test(uuid)) {
    return { error: "Invalid uuid" };
  }
  const slug = slugifyCwd(cwd);
  if (!slug) return { error: "Invalid cwd" };
  const transcriptPath = join(homeDir, ".claude", "projects", slug, `${uuid}.jsonl`);
  return { uuid, transcriptPath };
}

/**
 * Build the routes array.
 *
 * Expected ctx keys:
 *   json, parseJSON, auth, csrf
 *   watchlist      createWatchlist result  (list/get/add/remove)
 *   processor      createClaudeProcessor result  (acquire/release/refcount)
 *   topicBroker    createTopicBroker result  (subscribe)
 *   homeDir        absolute path; e.g. os.homedir()
 *   log            logger (optional)
 */
export function createClaudeFeedRoutes(ctx) {
  const {
    json, parseJSON, auth, csrf,
    watchlist, processor, topicBroker, homeDir,
    log,
  } = ctx;

  async function handleWatchPost(req, res) {
    if (!watchlist) return json(res, 503, { error: "Watchlist not available" });
    let body;
    try { body = await parseJSON(req, 2048); } catch (err) {
      return json(res, 400, { error: err.message });
    }

    // Only `{ uuid, cwd }` is accepted. A `{ session }` body means the
    // client didn't have a uuid — which means the SessionStart hook never
    // fired for that session. Send them to the setup command rather than
    // guessing a transcript.
    if (body && typeof body.session === "string" && !body.uuid) {
      log?.info?.("claude-feed-routes: watch rejected (no uuid)", {
        body: { session: body.session, hasCwd: typeof body.cwd === "string" },
      });
      return json(res, 400, {
        error: "Missing uuid. Run `katulong setup claude-hooks` to enable Claude feeds.",
      });
    }

    const target = resolveWatchTarget({ body, homeDir });
    if (target.error) {
      log?.info?.("claude-feed-routes: watch rejected", {
        error: target.error,
        body: body ? { hasUuid: typeof body.uuid === "string", hasCwd: typeof body.cwd === "string" } : null,
      });
      return json(res, 400, { error: target.error });
    }

    // Logging the transcript path + existence makes the "wrong feed opens"
    // class of bug debuggable without a TTY. A missing file here usually
    // means the cwd the frontend sent doesn't slugify to the directory
    // Claude Code actually used (space in path? symlink? worktree vs
    // canonical root?), and that's the most common failure mode.
    const exists = existsSync(target.transcriptPath);
    log?.info?.("claude-feed-routes: watch resolved", {
      uuid: target.uuid,
      transcriptPath: target.transcriptPath,
      transcriptExists: exists,
    });

    try {
      const entry = await watchlist.add(target.uuid, {
        transcriptPath: target.transcriptPath,
      });
      return json(res, 200, {
        uuid: target.uuid,
        transcriptPath: entry.transcriptPath,
        lastProcessedLine: entry.lastProcessedLine,
        addedAt: entry.addedAt,
      });
    } catch (err) {
      log?.warn?.("claude-feed-routes: add failed", { error: err.message });
      return json(res, 500, { error: "Failed to add to watchlist" });
    }
  }

  async function handleWatchDelete(req, res, uuid) {
    if (!watchlist) return json(res, 503, { error: "Watchlist not available" });
    if (!UUID_RE.test(uuid)) return json(res, 400, { error: "Invalid uuid" });
    try {
      const removed = await watchlist.remove(uuid);
      return json(res, removed ? 200 : 404, { ok: removed });
    } catch (err) {
      log?.warn?.("claude-feed-routes: remove failed", { error: err.message });
      return json(res, 500, { error: "Failed to remove from watchlist" });
    }
  }

  async function handleWatchlistGet(_req, res) {
    if (!watchlist) return json(res, 200, []);
    const all = await watchlist.list();
    const items = Object.entries(all).map(([uuid, entry]) => ({
      uuid,
      addedAt: entry.addedAt,
      lastProcessedLine: entry.lastProcessedLine,
      active: processor ? processor.refcount(uuid) > 0 : false,
    }));
    return json(res, 200, items);
  }

  async function handleStream(req, res, uuid) {
    if (!watchlist || !topicBroker || !processor) {
      return json(res, 503, { error: "Claude feed not available" });
    }
    if (!UUID_RE.test(uuid)) return json(res, 400, { error: "Invalid uuid" });

    const entry = await watchlist.get(uuid);
    if (!entry) return json(res, 404, { error: "Not on watchlist" });

    const url = new URL(req.url, "http://localhost");
    const fromSeqParam = url.searchParams.get("fromSeq");
    const lastEventId = req.headers["last-event-id"];
    const parsedParam = fromSeqParam !== null ? parseInt(fromSeqParam, 10) : NaN;
    const parsedLastId = lastEventId ? parseInt(lastEventId, 10) : NaN;
    const fromSeq = Number.isFinite(parsedParam) ? parsedParam
      : Number.isFinite(parsedLastId) ? parsedLastId + 1
      : 0;

    try {
      await processor.acquire(uuid);
    } catch (err) {
      log?.warn?.("claude-feed-routes: acquire failed", { error: err.message });
      return json(res, 500, { error: "Failed to start narration" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":ok\n\n");

    const unsubscribe = topicBroker.subscribe(`claude/${uuid}`, (envelope) => {
      res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
    }, { fromSeq });

    let released = false;
    function cleanup() {
      if (released) return;
      released = true;
      try { unsubscribe(); } catch { /* ok */ }
      try { processor.release(uuid); } catch (err) {
        log?.warn?.("claude-feed-routes: release failed", { error: err.message });
      }
    }
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  return [
    { method: "POST", path: "/api/claude/watch", handler: auth(csrf(handleWatchPost)) },
    { method: "DELETE", prefix: "/api/claude/watch/", handler: auth(csrf(handleWatchDelete)) },
    { method: "GET", path: "/api/claude/watchlist", handler: auth(handleWatchlistGet) },
    { method: "GET", prefix: "/api/claude/stream/", handler: auth(handleStream) },
  ];
}
