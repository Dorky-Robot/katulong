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
import { execFile } from "node:child_process";
import { UUID_RE, UUID_SEARCH_RE } from "../claude-event-transform.js";
import { slugifyCwd } from "../claude-transcript-discovery.js";
import { tmuxSocketArgs } from "../tmux.js";

/**
 * Find the Claude session UUID for a process by scraping its open files
 * for a `.claude/projects/<slug>/<uuid>.jsonl` path. Claude Code keeps this
 * JSONL open for append while the session is running, so lsof reliably
 * reports it. Returns { uuid, transcriptPath } or null.
 *
 * This is the authoritative "which Claude is running HERE right now" check
 * — better than the mtime heuristic because it pins to a live PID rather
 * than guessing from filesystem history.
 */
async function lsofClaudeUuid(pid) {
  const lsofOut = await new Promise(resolve => {
    execFile("lsof", ["-p", pid],
      { timeout: 5000, maxBuffer: 512 * 1024 },
      (err, stdout) => resolve(err ? "" : stdout)
    );
  });
  for (const line of lsofOut.split("\n")) {
    if (!line.includes(".claude/projects/")) continue;
    if (!line.endsWith(".jsonl")) continue;
    const m = line.match(UUID_SEARCH_RE);
    if (!m) continue;
    // lsof puts the filename in the last column. Filenames can contain
    // spaces (rare, but real when $HOME has a space), so we can't split
    // on whitespace — slice from the first `/` on the line to end instead.
    const pathStart = line.indexOf("/");
    if (pathStart < 0) continue;
    const transcriptPath = line.slice(pathStart);
    return { uuid: m[0], transcriptPath };
  }
  return null;
}

/**
 * Find the live Claude process in a Katulong session's tmux pane and return
 * its session UUID + transcript path. Returns null if no Claude is running
 * in the pane. This beats `resolveLatestTranscript` when the user has
 * multiple Claude sessions in the same project dir — we pick the one
 * actually running in THIS pane, not the most-recently-touched on disk.
 */
export async function findLiveClaudeInPane(sessionManager, sessionName) {
  if (!sessionManager || !sessionName) return null;
  const session = sessionManager.getSession?.(sessionName);
  if (!session?.alive || !session.tmuxName) return null;

  const panePid = await new Promise(resolve => {
    execFile("tmux", [...tmuxSocketArgs(), "list-panes", "-t", session.tmuxName, "-F", "#{pane_pid}"],
      { timeout: 3000 },
      (err, stdout) => resolve(err ? null : stdout.trim().split("\n")[0] || null)
    );
  });
  if (!panePid) return null;

  const childPids = await new Promise(resolve => {
    execFile("pgrep", ["-P", panePid],
      { timeout: 3000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([]);
        resolve(stdout.trim().split("\n"));
      }
    );
  });
  if (childPids.length === 0) return null;

  for (const pid of childPids) {
    const found = await lsofClaudeUuid(pid);
    if (found) return found;
  }
  return null;
}

/**
 * Build a { uuid, transcriptPath } target from an explicit { uuid, cwd }
 * body. Used when the frontend already knows the uuid (e.g. from
 * meta.claude.uuid populated by a SessionStart hook). The `{ session }`
 * shape is handled separately in `handleWatchPost` via live-process
 * inspection — there's no heuristic fallback, because the sparkle button
 * is only shown when a Claude process is actually running in the pane.
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

    // Two input shapes:
    //   { session } — look at the live Claude process running inside that
    //                 pane and read its open transcript JSONL. Pins us to
    //                 the exact session the user is staring at.
    //   { uuid, cwd } — fast path for callers that already know the uuid
    //                   (e.g. SessionStart hook populated meta.claude.uuid).
    //
    // No fallback between the two: the sparkle button only appears when a
    // Claude process is running, so if live detection can't find one we
    // return 404 rather than guessing a stale uuid from the filesystem.
    let target = null;
    if (body && typeof body.session === "string") {
      const hasSession = sessionManager?.getSession?.(body.session);
      if (!hasSession) return json(res, 400, { error: "Session not found" });
      const live = await findLiveClaudeInPane(sessionManager, body.session);
      if (!live) {
        return json(res, 404, { error: "No Claude process running in session pane" });
      }
      target = { uuid: live.uuid, transcriptPath: live.transcriptPath };
    } else {
      target = resolveWatchTarget({ body, homeDir });
      if (target.error) return json(res, 400, { error: target.error });
    }

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
