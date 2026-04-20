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
import { existsSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { UUID_RE } from "../claude-event-transform.js";
import { slugifyCwd } from "../claude-transcript-discovery.js";

// Size cap when sniffing a transcript for its cwd. User/system entries
// that carry `cwd` tend to land in the first few lines of a JSONL, so
// peeking at the head is enough to avoid slurping a multi-MB file when
// all we need is one field.
const TRANSCRIPT_CWD_SNIFF_BYTES = 64 * 1024;

/**
 * Read the head of a Claude transcript and return the first absolute
 * `cwd` string we find. Returns `null` if the file is unreadable, the
 * head chunk contains no parseable JSON lines, or none of them carry a
 * cwd field.
 *
 * Only reads the first TRANSCRIPT_CWD_SNIFF_BYTES bytes — enough for
 * the session_init / first user entry that stamps cwd, without blowing
 * the request budget on a huge transcript. If cwd lives past that
 * point in an unusual transcript, the caller can fall back to manual
 * entry; Claude itself resumes the right directory via `--resume` so
 * the only consumer of this helper is the "where should the new shell
 * start?" prompt.
 */
function readTranscriptCwd(transcriptPath) {
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(TRANSCRIPT_CWD_SNIFF_BYTES);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, bytesRead).toString("utf8");
    // Drop the final partial line — it may have been truncated by the
    // size cap and JSON.parse would throw on it.
    const lines = text.split("\n");
    if (lines.length > 0 && bytesRead === buf.length) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry && typeof entry.cwd === "string" && entry.cwd.startsWith("/")) {
        return entry.cwd;
      }
    }
    return null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Find `<uuid>.jsonl` anywhere under `<homeDir>/.claude/projects/*`.
 *
 * Claude Code's on-disk slug rule is cwd-at-launch. If the cwd the
 * frontend sends (live tmux pane cwd) has drifted since launch — the
 * user cd'd into a worktree, a subdirectory, or a symlinked path — the
 * slug we derive points at an empty directory Claude never wrote to and
 * the feed stalls silently. This scan recovers from that: since UUIDs
 * are globally unique, exactly one project directory can contain
 * `<uuid>.jsonl`. We read each top-level project dir and check for the
 * file; `readdirSync` plus a single `existsSync` per candidate is cheap
 * even at a few hundred historical project directories, and this only
 * runs on the watch-add path (once per sparkle click).
 *
 * Returns an absolute path or `null` if no match exists.
 */
export function findTranscriptByUuid(homeDir, uuid) {
  if (!homeDir || typeof homeDir !== "string") return null;
  if (!uuid || !UUID_RE.test(uuid)) return null;
  const projectsRoot = join(homeDir, ".claude", "projects");
  let entries;
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const leaf = `${uuid}.jsonl`;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const candidate = join(projectsRoot, ent.name, leaf);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Build a { uuid, transcriptPath } target from a watch-add body.
 *
 * Resolution precedence (most reliable first):
 *
 *   1. `{ uuid, session }` with the session's `meta.claude.transcriptPath`
 *      stamped from the Claude Code SessionStart hook. This is ground
 *      truth — Claude Code itself told us where the transcript lives.
 *
 *   2. `{ uuid, cwd }` with the slugified cwd-derived path existing on
 *      disk. Matches Claude Code's on-disk slug rule (see
 *      `slugifyCwd`) and works for sessions where the cwd at launch
 *      matches the cwd at click time.
 *
 *   3. `{ uuid, cwd }` glob fallback — scan `~/.claude/projects/*` for
 *      `<uuid>.jsonl`. Handles the case where the frontend's cwd has
 *      drifted (worktree vs canonical root, post-cd shell state, etc.)
 *      but the SessionStart hook never fired (install-after-start).
 *
 *   4. Slug path anyway — returned even when the file doesn't exist, so
 *      the watchlist entry can be created and the processor picks the
 *      transcript up if it materializes later.
 *
 * Returns `{ uuid, transcriptPath, source }` on success or `{ error }`
 * on failure. `source` is one of `"session-meta" | "cwd-slug" | "glob"
 * | "cwd-slug-missing"` for diagnostic logging.
 */
export function resolveWatchTarget({ body, homeDir, sessionManager = null }) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const uuid = typeof body.uuid === "string" ? body.uuid : null;
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const sessionName = typeof body.session === "string" ? body.session : null;

  if (!uuid) {
    return { error: "Missing uuid" };
  }
  if (!UUID_RE.test(uuid)) {
    return { error: "Invalid uuid" };
  }

  // (1) Session-meta stamped by the SessionStart hook. The session must
  //     hold the *same* uuid — stale meta from a previous Claude session
  //     in the same pane doesn't apply to this watch request.
  if (sessionName && sessionManager?.getSession) {
    const session = sessionManager.getSession(sessionName);
    const stamped = session?.meta?.claude;
    if (stamped?.uuid === uuid && typeof stamped.transcriptPath === "string") {
      return { uuid, transcriptPath: stamped.transcriptPath, source: "session-meta" };
    }
  }

  // Remaining branches need a cwd to derive the slug or to fall back to
  // glob. Without either a session-meta match or a cwd we have nothing
  // to try.
  if (!cwd) {
    return { error: "Missing cwd" };
  }
  const slug = slugifyCwd(cwd);
  if (!slug) return { error: "Invalid cwd" };
  const slugPath = join(homeDir, ".claude", "projects", slug, `${uuid}.jsonl`);

  // (2) Slug path exists on disk — trust it.
  if (existsSync(slugPath)) {
    return { uuid, transcriptPath: slugPath, source: "cwd-slug" };
  }

  // (3) Glob fallback — UUIDs are globally unique, so a directory
  //     containing `<uuid>.jsonl` identifies the right project.
  const globHit = findTranscriptByUuid(homeDir, uuid);
  if (globHit) {
    return { uuid, transcriptPath: globHit, source: "glob" };
  }

  // (4) Return the slug path anyway so the watchlist can be entered; the
  //     file may appear if Claude Code creates it after this request.
  return { uuid, transcriptPath: slugPath, source: "cwd-slug-missing" };
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
 *   sessionManager (optional) used to look up stamped meta.claude
 *                   .transcriptPath from the SessionStart hook
 *   log            logger (optional)
 */
export function createClaudeFeedRoutes(ctx) {
  const {
    json, parseJSON, auth, csrf,
    watchlist, processor, topicBroker, homeDir, sessionManager,
    log,
  } = ctx;

  async function handleWatchPost(req, res) {
    if (!watchlist) return json(res, 503, { error: "Watchlist not available" });
    let body;
    try { body = await parseJSON(req, 2048); } catch (err) {
      return json(res, 400, { error: err.message });
    }

    // A `{ session }` body without a uuid means the SessionStart hook
    // never fired for that session — we can't pick one of the potentially
    // many JSONLs for that cwd. Send them to the setup command rather
    // than guessing.
    if (body && typeof body.session === "string" && !body.uuid) {
      return json(res, 400, {
        error: "Missing uuid. Run `katulong setup claude-hooks` to enable Claude feeds.",
      });
    }

    const target = resolveWatchTarget({ body, homeDir, sessionManager });
    if (target.error) return json(res, 400, { error: target.error });

    // Still missing after all three resolution branches — log it so
    // operators can spot the mismatch. We still add to the watchlist;
    // the file may appear if Claude Code writes it later.
    if (target.source === "cwd-slug-missing") {
      log?.warn?.("claude-feed-routes: transcript not found on watch-add", {
        uuid: target.uuid,
        transcriptPath: target.transcriptPath,
      });
    }

    try {
      const entry = await watchlist.add(target.uuid, {
        transcriptPath: target.transcriptPath,
      });
      // transcriptPath is deliberately omitted — it's an absolute host path
      // (`/Users/<user>/.claude/projects/...`) that the client has no use for
      // and that would leak the server's filesystem layout.
      return json(res, 200, {
        uuid: target.uuid,
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

    // From this point on the refcount is held — we must release it on any
    // error path below, or the worker runs forever with no subscriber.
    let unsubscribe = null;
    let released = false;
    function cleanup() {
      if (released) return;
      released = true;
      if (unsubscribe) { try { unsubscribe(); } catch { /* ok */ } }
      try { processor.release(uuid); } catch (err) {
        log?.warn?.("claude-feed-routes: release failed", { error: err.message });
      }
    }

    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":ok\n\n");

      unsubscribe = topicBroker.subscribe(`claude/${uuid}`, (envelope) => {
        try {
          res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
        } catch (err) {
          // Socket already closed under us — unsubscribe + release rather
          // than letting write-after-end bubble out of the publish loop.
          log?.warn?.("claude-feed-routes: SSE write failed", { error: err.message });
          cleanup();
        }
      }, { fromSeq });
    } catch (err) {
      log?.warn?.("claude-feed-routes: stream setup failed", { error: err.message });
      cleanup();
      return;
    }

    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  // Surface the cwd a Claude session was launched in so the UI can spawn
  // a fresh terminal in the right directory and run `claude --resume`.
  // The watchlist tracks transcriptPath per-uuid; we sniff the head of
  // that file for the first entry with a cwd field.
  async function handleSessionInfo(_req, res, uuid) {
    if (!watchlist) return json(res, 503, { error: "Watchlist not available" });
    if (!UUID_RE.test(uuid)) return json(res, 400, { error: "Invalid uuid" });
    const entry = await watchlist.get(uuid);
    if (!entry) return json(res, 404, { error: "Not on watchlist" });
    const cwd = readTranscriptCwd(entry.transcriptPath);
    if (!cwd) return json(res, 404, { error: "Cwd not found in transcript" });
    return json(res, 200, { uuid, cwd });
  }

  // Delete the topic's persisted log + rewind the watchlist cursor so the
  // next processor cycle re-reads the whole transcript from line 0. Used
  // by the "clear old Ollama output and reprocess" workflow — without
  // this, flipping from the pre-rewire narrator to the new reply-first
  // shape would leave a mix of old narrative/summary events and new reply
  // events in the same log. Deleting the log is safe: the transcript on
  // disk is the source of truth, so events are reconstructible on the
  // next subscribe.
  async function handleReprocess(_req, res, uuid) {
    if (!watchlist || !topicBroker) {
      return json(res, 503, { error: "Claude feed not available" });
    }
    if (!UUID_RE.test(uuid)) return json(res, 400, { error: "Invalid uuid" });

    const entry = await watchlist.get(uuid);
    if (!entry) return json(res, 404, { error: "Not on watchlist" });

    try {
      topicBroker.deleteTopic(`claude/${uuid}`);
    } catch (err) {
      log?.warn?.("claude-feed-routes: topic delete failed", { uuid, error: err.message });
    }
    const reset = await watchlist.reset(uuid);
    return json(res, 200, { ok: true, lastProcessedLine: reset?.lastProcessedLine ?? 0 });
  }

  return [
    { method: "POST", path: "/api/claude/watch", handler: auth(csrf(handleWatchPost)) },
    { method: "DELETE", prefix: "/api/claude/watch/", handler: auth(csrf(handleWatchDelete)) },
    { method: "GET", path: "/api/claude/watchlist", handler: auth(handleWatchlistGet) },
    { method: "GET", prefix: "/api/claude/session-info/", handler: auth(handleSessionInfo) },
    { method: "GET", prefix: "/api/claude/stream/", handler: auth(handleStream) },
    { method: "POST", prefix: "/api/claude/reprocess/", handler: auth(csrf(handleReprocess)) },
  ];
}
