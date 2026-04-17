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
import {
  slugifyCwd, resolveLatestTranscript,
} from "../claude-transcript-discovery.js";
import { tmuxSocketArgs } from "../tmux.js";

const RESOLVE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — "recent enough to matter"

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

    // Live-process detection first — this is the authoritative answer when
    // hooks aren't installed. When the user clicks sparkle from a terminal
    // pane, we look at the live Claude process running INSIDE that pane
    // and read its open transcript JSONL. That pins us to the exact
    // session the user is looking at, not the newest .jsonl in the project
    // dir (which may be from a different Claude window).
    let target = null;
    if (body && typeof body.session === "string" && !body.uuid) {
      const live = await findLiveClaudeInPane(sessionManager, body.session);
      if (live) {
        target = { uuid: live.uuid, transcriptPath: live.transcriptPath };
      }
    }

    if (!target) {
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
      target = resolveWatchTarget({ body, sessionCwd, homeDir });
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
