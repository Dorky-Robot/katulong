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
 */

import { join } from "node:path";
import { UUID_RE } from "../claude-event-transform.js";
import {
  slugifyCwd, resolveLatestTranscript,
} from "../claude-transcript-discovery.js";

const RESOLVE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — "recent enough to matter"

/**
 * Turn a POST /api/claude/watch body into a { uuid, transcriptPath } target.
 *
 * Input shapes (checked in order):
 *   { uuid, cwd }     client already knows the UUID and its cwd. We slug the
 *                     cwd to locate the transcript file.
 *   { session } + sessionCwd   caller has resolved the session's working
 *                              directory; we auto-discover the newest recent
 *                              transcript under it.
 *
 * Pure function — the caller is responsible for resolving `sessionCwd` via
 * whatever precedence is appropriate (e.g. meta.claude.cwd → meta.pane.cwd →
 * live tmux pane cwd). See `docs/file-link-worktree-resolution.md` for why
 * the pane cwd can lie when Claude is launched with `--add-dir`.
 *
 * Returns `{ uuid, transcriptPath }` on success or `{ error }` on failure.
 */
export function resolveWatchTarget({
  body, sessionCwd = null, homeDir, now = Date.now(),
}) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const uuid = typeof body.uuid === "string" ? body.uuid : null;
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const sessionName = typeof body.session === "string" ? body.session : null;

  if (uuid && !UUID_RE.test(uuid)) {
    return { error: "Invalid uuid" };
  }

  if (uuid && cwd) {
    const slug = slugifyCwd(cwd);
    if (!slug) return { error: "Invalid cwd" };
    const transcriptPath = join(homeDir, ".claude", "projects", slug, `${uuid}.jsonl`);
    return { uuid, transcriptPath };
  }

  if (sessionName) {
    if (!sessionCwd) return { error: "Session has no cwd" };
    const resolved = resolveLatestTranscript({
      cwd: sessionCwd,
      home: homeDir,
      maxAgeMs: RESOLVE_MAX_AGE_MS,
      now,
    });
    if (!resolved) return { error: "No recent Claude transcript under session cwd" };
    return { uuid: resolved.uuid, transcriptPath: resolved.transcriptPath };
  }

  return { error: "Provide either { uuid, cwd } or { session }" };
}

/**
 * Resolve a session's working directory with forward-compat precedence:
 *   1. meta.claude.cwd — Claude's actual process cwd (future; see PR #613
 *      step 4). Correct even when claude was launched with `--add-dir`.
 *   2. meta.pane.cwd   — shell cwd cached by the pane monitor (future; PR
 *      #613 step 1). Correct in the common case where the user cd'd into
 *      the worktree before launching claude.
 *   3. Live tmux pane cwd via sessionManager.getSessionCwd() — today's
 *      fallback. Same data source as (2), just polled on demand.
 *
 * Returns the string cwd or null.
 */
async function resolveSessionCwd(sessionManager, sessionName) {
  if (!sessionManager) return null;
  const session = sessionManager.getSession?.(sessionName) || null;
  if (!session) return null;
  const metaClaudeCwd = session.meta?.claude?.cwd;
  if (typeof metaClaudeCwd === "string" && metaClaudeCwd) return metaClaudeCwd;
  const metaPaneCwd = session.meta?.pane?.cwd;
  if (typeof metaPaneCwd === "string" && metaPaneCwd) return metaPaneCwd;
  if (typeof sessionManager.getSessionCwd === "function") {
    try {
      const live = await sessionManager.getSessionCwd(sessionName);
      return typeof live === "string" && live ? live : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build the routes array.
 *
 * Expected ctx keys:
 *   json, parseJSON, auth, csrf
 *   watchlist      createWatchlist result  (list/get/add/remove)
 *   processor      createClaudeProcessor result  (acquire/release/refcount)
 *   topicBroker    createTopicBroker result  (subscribe)
 *   sessionManager
 *   homeDir        absolute path; e.g. os.homedir()
 *   log            logger (optional)
 */
export function createClaudeFeedRoutes(ctx) {
  const {
    json, parseJSON, auth, csrf,
    watchlist, processor, topicBroker, sessionManager, homeDir,
    log,
  } = ctx;

  async function handleWatchPost(req, res) {
    if (!watchlist) return json(res, 503, { error: "Watchlist not available" });
    let body;
    try { body = await parseJSON(req, 2048); } catch (err) {
      return json(res, 400, { error: err.message });
    }

    let sessionCwd = null;
    if (body && typeof body.session === "string") {
      sessionCwd = await resolveSessionCwd(sessionManager, body.session);
      if (!sessionCwd) {
        const hasSession = sessionManager?.getSession?.(body.session);
        return json(res, 400, {
          error: hasSession ? "Session has no cwd" : "Session not found",
        });
      }
    }

    const target = resolveWatchTarget({ body, sessionCwd, homeDir });
    if (target.error) return json(res, 400, { error: target.error });

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
