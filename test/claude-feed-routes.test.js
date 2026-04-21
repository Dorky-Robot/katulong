/**
 * Claude feed routes tests.
 *
 * Covers:
 *   - resolveWatchTarget pure helper (input shapes, error cases)
 *   - route handlers invoked with fake req/res against a real watchlist +
 *     a fake processor + a fake topic broker. Auth/csrf are no-op wrappers.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { createWatchlist } from "../lib/claude-watchlist.js";
import {
  resolveWatchTarget,
  findTranscriptByUuid,
  createClaudeFeedRoutes,
} from "../lib/routes/claude-feed-routes.js";
import { slugifyCwd } from "../lib/claude-transcript-discovery.js";
import { createPermissionStore } from "../lib/claude-permissions.js";

const UUID = "ff16582e-bbb4-49c6-90cf-e731be656442";
const UUID_B = "01234567-89ab-cdef-0123-456789abcdef";

function makeRes() {
  const res = new EventEmitter();
  res.status = null;
  res.headers = null;
  res.chunks = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res; };
  res.write = (c) => { res.chunks.push(c); return true; };
  res.end = (c) => { if (c) res.chunks.push(c); res.ended = true; };
  return res;
}

function makeReq({ method = "GET", url = "/", body = null, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req._body = body;
  return req;
}

function makeCtx({ watchlist, processor, topicBroker, sessionManager, homeDir, permissionStore }) {
  const parseJSON = async (req) => req._body;
  const json = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return { status, data };
  };
  const passthrough = (h) => h;
  return {
    json, parseJSON, auth: passthrough, csrf: passthrough,
    watchlist, processor, topicBroker, sessionManager, homeDir,
    permissionStore,
    log: null,
  };
}

function makeFakeProcessor() {
  const calls = { acquire: [], release: [] };
  const counts = new Map();
  return {
    calls,
    async acquire(uuid) {
      calls.acquire.push(uuid);
      counts.set(uuid, (counts.get(uuid) || 0) + 1);
      return counts.get(uuid);
    },
    release(uuid) {
      calls.release.push(uuid);
      const next = Math.max(0, (counts.get(uuid) || 0) - 1);
      counts.set(uuid, next);
      return next;
    },
    refcount: (uuid) => counts.get(uuid) || 0,
    has: (uuid) => (counts.get(uuid) || 0) > 0,
    destroy() {},
  };
}

function makeFakeBroker() {
  const subscribers = new Map();
  return {
    subscribers,
    subscribe(topic, cb) {
      if (!subscribers.has(topic)) subscribers.set(topic, new Set());
      subscribers.get(topic).add(cb);
      return () => subscribers.get(topic)?.delete(cb);
    },
    publish(topic, message) {
      const subs = subscribers.get(topic);
      if (!subs) return 0;
      const envelope = { topic, message, seq: 1, timestamp: Date.now() };
      for (const cb of subs) cb(envelope);
      return subs.size;
    },
  };
}

describe("resolveWatchTarget", () => {
  let home;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "katulong-resolve-target-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // Create `<home>/.claude/projects/<slug>/<uuid>.jsonl` so `existsSync`
  // checks in resolveWatchTarget see the file.
  function writeTranscript(slug, uuid) {
    const dir = join(home, ".claude", "projects", slug);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${uuid}.jsonl`);
    writeFileSync(path, "");
    return path;
  }

  it("rejects an empty body", () => {
    const out = resolveWatchTarget({ body: null, homeDir: home });
    assert.match(out.error, /JSON object/);
  });

  it("rejects when uuid missing", () => {
    const out = resolveWatchTarget({ body: {}, homeDir: home });
    assert.match(out.error, /Missing uuid/);
  });

  it("rejects when cwd missing and no session-meta resolves", () => {
    const out = resolveWatchTarget({ body: { uuid: UUID }, homeDir: home });
    assert.match(out.error, /Missing cwd/);
  });

  it("rejects an invalid uuid", () => {
    const out = resolveWatchTarget({ body: { uuid: "nope", cwd: "/x" }, homeDir: home });
    assert.match(out.error, /Invalid uuid/);
  });

  it("returns cwd-slug path when the slug file exists on disk", () => {
    const cwd = "/Users/felix/Projects/katulong";
    const slug = slugifyCwd(cwd);
    const expected = writeTranscript(slug, UUID);
    const out = resolveWatchTarget({ body: { uuid: UUID, cwd }, homeDir: home });
    assert.strictEqual(out.transcriptPath, expected);
    assert.strictEqual(out.source, "cwd-slug");
  });

  it("prefers session-meta transcriptPath when the session's meta matches the uuid", () => {
    // Ground truth comes from the SessionStart hook. Even if the cwd
    // slug path also exists, the stamped path wins because it reflects
    // what Claude Code actually reported at launch time.
    const sessionManager = {
      getSession: () => ({
        meta: { claude: { uuid: UUID, transcriptPath: "/abs/from/hook.jsonl" } },
      }),
    };
    const cwd = "/Users/felix/Projects/katulong";
    writeTranscript(slugifyCwd(cwd), UUID); // on-disk, still ignored
    const out = resolveWatchTarget({
      body: { uuid: UUID, cwd, session: "work" },
      homeDir: home,
      sessionManager,
    });
    assert.strictEqual(out.transcriptPath, "/abs/from/hook.jsonl");
    assert.strictEqual(out.source, "session-meta");
  });

  it("ignores session-meta when its uuid doesn't match the requested uuid", () => {
    // Stale meta from a previous Claude run in the same pane must not
    // hijack a new request — only a meta.claude.uuid that matches the
    // requested watch-target uuid is trusted.
    const sessionManager = {
      getSession: () => ({
        meta: {
          claude: {
            uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            transcriptPath: "/stale/path.jsonl",
          },
        },
      }),
    };
    const cwd = "/Users/felix/Projects/katulong";
    const expected = writeTranscript(slugifyCwd(cwd), UUID);
    const out = resolveWatchTarget({
      body: { uuid: UUID, cwd, session: "work" },
      homeDir: home,
      sessionManager,
    });
    assert.strictEqual(out.transcriptPath, expected);
    assert.strictEqual(out.source, "cwd-slug");
  });

  it("falls back to a glob scan when the cwd-slug file doesn't exist", () => {
    // Typical stall case: the frontend's live cwd slugified into a dir
    // Claude Code never wrote to (worktree vs canonical repo). The glob
    // finds the real transcript by UUID — the uuid is globally unique
    // so exactly one project dir can contain `<uuid>.jsonl`.
    const realSlug = "-Users-felix-Projects-katulong";
    const expected = writeTranscript(realSlug, UUID);
    const out = resolveWatchTarget({
      body: { uuid: UUID, cwd: "/Users/felix/.claude/worktrees/whatever" },
      homeDir: home,
    });
    assert.strictEqual(out.transcriptPath, expected);
    assert.strictEqual(out.source, "glob");
  });

  it("returns cwd-slug-missing when nothing resolves — watchlist still entered", () => {
    // No hook-stamp, no existing file, no glob match. The handler still
    // returns a path so the watchlist entry can be created; the file
    // might appear if Claude Code writes it after the request.
    const cwd = "/Users/felix/Projects/katulong";
    const out = resolveWatchTarget({
      body: { uuid: UUID, cwd },
      homeDir: home,
    });
    assert.strictEqual(out.source, "cwd-slug-missing");
    assert.ok(out.transcriptPath.endsWith(`${UUID}.jsonl`));
  });
});

describe("findTranscriptByUuid", () => {
  let home;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "katulong-find-transcript-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when ~/.claude/projects doesn't exist", () => {
    assert.strictEqual(findTranscriptByUuid(home, UUID), null);
  });

  it("returns null for an invalid uuid", () => {
    assert.strictEqual(findTranscriptByUuid(home, "not-a-uuid"), null);
  });

  it("returns the path when the file exists in any project directory", () => {
    const dir = join(home, ".claude", "projects", "-some-slug");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${UUID}.jsonl`);
    writeFileSync(path, "");
    assert.strictEqual(findTranscriptByUuid(home, UUID), path);
  });

  it("returns null when the uuid isn't present in any project directory", () => {
    const dir = join(home, ".claude", "projects", "-some-slug");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${UUID_B}.jsonl`), "");
    assert.strictEqual(findTranscriptByUuid(home, UUID), null);
  });
});

describe("createClaudeFeedRoutes", () => {
  let dataDir;
  let home;
  let watchlist;
  let processor;
  let broker;
  let sessionManager;
  let ctx;
  let routes;

  function routeFor(method, pathOrPrefix) {
    return routes.find(r =>
      r.method === method && (r.path === pathOrPrefix || r.prefix === pathOrPrefix)
    );
  }

  let permissionStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-feed-routes-"));
    home = mkdtempSync(join(tmpdir(), "katulong-feed-routes-home-"));
    watchlist = createWatchlist({ dataDir });
    processor = makeFakeProcessor();
    broker = makeFakeBroker();
    sessionManager = { getSession: () => null };
    permissionStore = createPermissionStore();
    ctx = makeCtx({
      watchlist, processor, topicBroker: broker, sessionManager, homeDir: home,
      permissionStore,
    });
    routes = createClaudeFeedRoutes(ctx);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("exposes the expected routes", () => {
    const keys = routes.map(r => [r.method, r.path || r.prefix]);
    assert.deepStrictEqual(keys, [
      ["POST", "/api/claude/watch"],
      ["DELETE", "/api/claude/watch/"],
      ["GET", "/api/claude/watchlist"],
      ["GET", "/api/claude/session-info/"],
      ["GET", "/api/claude/stream/"],
      ["POST", "/api/claude/reprocess/"],
      ["POST", "/api/claude/permission"],
    ]);
  });

  it("GET /api/claude/session-info/:uuid returns cwd sniffed from the transcript head", async () => {
    // Claude Code writes per-turn entries with a `cwd` field. The feed
    // tile's open-terminal button needs to know where to spawn a shell
    // when the original Claude session is no longer live — the head of
    // the transcript is authoritative and cheap to read.
    const transcriptDir = join(home, ".claude", "projects", "-Users-felix-proj");
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, `${UUID}.jsonl`);
    const lines = [
      JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
      JSON.stringify({ type: "user", cwd: "/Users/felix/Projects/katulong", message: "hi" }),
    ];
    writeFileSync(transcriptPath, lines.join("\n") + "\n");
    await watchlist.add(UUID, { transcriptPath });

    const route = routeFor("GET", "/api/claude/session-info/");
    const res = makeRes();
    await route.handler(makeReq(), res, UUID);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.chunks[0]), {
      uuid: UUID,
      cwd: "/Users/felix/Projects/katulong",
    });
  });

  it("GET /api/claude/session-info/:uuid returns 404 when uuid isn't on the watchlist", async () => {
    const route = routeFor("GET", "/api/claude/session-info/");
    const res = makeRes();
    await route.handler(makeReq(), res, UUID);
    assert.strictEqual(res.status, 404);
  });

  it("GET /api/claude/session-info/:uuid returns 404 when transcript has no cwd", async () => {
    // A transcript that only contains system-y entries (no user turn
    // ever recorded) has no cwd we can trust. Return 404 so the caller
    // can show a clear toast instead of spawning a shell in an arbitrary
    // directory.
    const transcriptDir = join(home, ".claude", "projects", "-no-cwd");
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, `${UUID}.jsonl`);
    writeFileSync(transcriptPath, JSON.stringify({ type: "permission-mode" }) + "\n");
    await watchlist.add(UUID, { transcriptPath });

    const route = routeFor("GET", "/api/claude/session-info/");
    const res = makeRes();
    await route.handler(makeReq(), res, UUID);
    assert.strictEqual(res.status, 404);
    assert.match(JSON.parse(res.chunks[0]).error, /Cwd not found/);
  });

  it("GET /api/claude/session-info/:uuid rejects an invalid uuid with 400", async () => {
    const route = routeFor("GET", "/api/claude/session-info/");
    const res = makeRes();
    await route.handler(makeReq(), res, "not-a-uuid");
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/claude/watch adds by { uuid, cwd } and returns the entry", async () => {
    const route = routeFor("POST", "/api/claude/watch");
    const req = makeReq({ method: "POST", body: { uuid: UUID, cwd: "/Users/felix/proj" } });
    const res = makeRes();
    await route.handler(req, res);
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.chunks[0]);
    assert.strictEqual(body.uuid, UUID);
    // transcriptPath is server-internal — the client does not see it
    // (absolute host paths leak filesystem layout).
    assert.strictEqual(body.transcriptPath, undefined);
    assert.strictEqual(body.lastProcessedLine, 0);

    const stored = await watchlist.get(UUID);
    assert.ok(stored);
    assert.ok(stored.transcriptPath.endsWith(`${UUID}.jsonl`));
  });

  it("POST /api/claude/watch prefers session-meta transcriptPath over cwd slug", async () => {
    // The SessionStart hook stamped `meta.claude.transcriptPath` — the
    // route must trust it even when a slug-derived path would also
    // resolve. This is the fix for the "feed stalled at X AM" bug: the
    // live tmux pane cwd had drifted, so the slug path was wrong, but
    // the hook's transcript_path always points at Claude's real file.
    const stampedPath = "/abs/from/hook.jsonl";
    ctx.sessionManager = {
      getSession: () => ({
        meta: { claude: { uuid: UUID, transcriptPath: stampedPath } },
      }),
    };
    routes = createClaudeFeedRoutes(ctx);
    const route = routeFor("POST", "/api/claude/watch");
    const req = makeReq({
      method: "POST",
      body: { uuid: UUID, cwd: "/Users/felix/proj", session: "work" },
    });
    await route.handler(req, makeRes());

    const stored = await watchlist.get(UUID);
    assert.strictEqual(stored.transcriptPath, stampedPath);
  });

  it("POST /api/claude/watch is idempotent — re-adding preserves cursor", async () => {
    const route = routeFor("POST", "/api/claude/watch");
    // First add
    await route.handler(
      makeReq({ method: "POST", body: { uuid: UUID, cwd: "/Users/felix/proj" } }),
      makeRes(),
    );
    // Advance cursor via watchlist (simulates narrate publish)
    await watchlist.advance(UUID, 42);
    // Second add — cursor should stay at 42
    const res2 = makeRes();
    await route.handler(
      makeReq({ method: "POST", body: { uuid: UUID, cwd: "/Users/felix/proj" } }),
      res2,
    );
    const body = JSON.parse(res2.chunks[0]);
    assert.strictEqual(body.lastProcessedLine, 42);
  });

  it("POST /api/claude/watch rejects a bad body with 400", async () => {
    const route = routeFor("POST", "/api/claude/watch");
    const res = makeRes();
    await route.handler(makeReq({ method: "POST", body: {} }), res);
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/claude/watch { session } without uuid — 400 pointing to hook setup", async () => {
    // The server can't resolve a uuid from session name alone — prior
    // attempts (mtime scan, lsof on the pane pid) both picked the wrong
    // transcript when Claude Code has multiple JSONLs open (compaction
    // context). The only reliable signal is the SessionStart hook. If the
    // client didn't populate meta.claude.uuid, we point them at the
    // hook-install command rather than guessing.
    const route = routeFor("POST", "/api/claude/watch");
    const res = makeRes();
    await route.handler(makeReq({ method: "POST", body: { session: "work" } }), res);
    assert.strictEqual(res.status, 400);
    assert.match(JSON.parse(res.chunks[0]).error, /katulong setup claude-hooks/);
  });

  it("DELETE /api/claude/watch/:uuid removes an existing entry", async () => {
    await watchlist.add(UUID, { transcriptPath: "/x/foo.jsonl" });
    const route = routeFor("DELETE", "/api/claude/watch/");
    const res = makeRes();
    await route.handler(makeReq({ method: "DELETE" }), res, UUID);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await watchlist.get(UUID), null);
  });

  it("DELETE returns 404 when the uuid isn't on the watchlist", async () => {
    const route = routeFor("DELETE", "/api/claude/watch/");
    const res = makeRes();
    await route.handler(makeReq({ method: "DELETE" }), res, UUID);
    assert.strictEqual(res.status, 404);
  });

  it("DELETE rejects an invalid uuid with 400", async () => {
    const route = routeFor("DELETE", "/api/claude/watch/");
    const res = makeRes();
    await route.handler(makeReq({ method: "DELETE" }), res, "not-a-uuid");
    assert.strictEqual(res.status, 400);
  });

  it("GET /api/claude/watchlist returns an array with active flags", async () => {
    await watchlist.add(UUID, { transcriptPath: "/x/a.jsonl" });
    await watchlist.add(UUID_B, { transcriptPath: "/x/b.jsonl" });
    await processor.acquire(UUID); // fake refcount bump

    const route = routeFor("GET", "/api/claude/watchlist");
    const res = makeRes();
    await route.handler(makeReq(), res);
    assert.strictEqual(res.status, 200);
    const list = JSON.parse(res.chunks[0]);
    const byUuid = new Map(list.map(i => [i.uuid, i]));
    assert.strictEqual(byUuid.get(UUID).active, true);
    assert.strictEqual(byUuid.get(UUID_B).active, false);
    assert.ok(byUuid.get(UUID).addedAt > 0);
  });

  it("GET /api/claude/stream/:uuid — 404 when uuid isn't on watchlist", async () => {
    const route = routeFor("GET", "/api/claude/stream/");
    const res = makeRes();
    await route.handler(makeReq({ url: `/api/claude/stream/${UUID}` }), res, UUID);
    assert.strictEqual(res.status, 404);
  });

  it("GET /api/claude/stream/:uuid acquires, subscribes, releases on close", async () => {
    await watchlist.add(UUID, { transcriptPath: "/x/foo.jsonl" });
    const route = routeFor("GET", "/api/claude/stream/");

    const req = makeReq({ url: `/api/claude/stream/${UUID}?fromSeq=0` });
    const res = makeRes();
    // Handler doesn't await anything once the SSE stream starts — it registers listeners.
    await route.handler(req, res, UUID);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["Content-Type"], "text/event-stream");
    assert.deepStrictEqual(processor.calls.acquire, [UUID]);
    assert.strictEqual(broker.subscribers.get(`claude/${UUID}`).size, 1);

    // Publish a message — SSE should serialize it
    broker.publish(`claude/${UUID}`, JSON.stringify({ hi: "there" }));
    const sseFrame = res.chunks.find(c => typeof c === "string" && c.startsWith("id:"));
    assert.ok(sseFrame, "expected an SSE id: frame");

    // Simulate client disconnect → processor.release
    req.emit("close");
    assert.deepStrictEqual(processor.calls.release, [UUID]);
    assert.strictEqual(broker.subscribers.get(`claude/${UUID}`).size, 0);

    // Second close is a no-op
    res.emit("close");
    assert.strictEqual(processor.calls.release.length, 1);
  });

  it("GET /api/claude/stream/:uuid rejects an invalid uuid with 400", async () => {
    const route = routeFor("GET", "/api/claude/stream/");
    const res = makeRes();
    await route.handler(makeReq(), res, "not-a-uuid");
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(processor.calls.acquire, []);
  });

  // Build a sessionManager stub that answers listSessions + getSession in
  // the shape handlePermissionPost expects. The captured `writes` array
  // records every session.write() call so tests can assert the keystroke
  // made it through.
  function stubSessionManagerForUuid(uuid, writes) {
    const session = {
      name: "work",
      alive: true,
      meta: { claude: { uuid } },
      write(data) { writes.push(data); },
    };
    return {
      listSessions: () => ({ sessions: [session] }),
      getSession: (name) => (name === "work" ? session : null),
    };
  }

  it("POST /api/claude/permission sends '1' for allow and publishes resolved", async () => {
    const writes = [];
    ctx.sessionManager = stubSessionManagerForUuid(UUID, writes);
    routes = createClaudeFeedRoutes(ctx);

    const record = permissionStore.add({ uuid: UUID, message: "perm", tool: "Bash" });
    const route = routeFor("POST", "/api/claude/permission");
    const published = [];
    broker.subscribe(`claude/${UUID}`, (env) => published.push(env.message));

    const req = makeReq({ method: "POST", body: { requestId: record.requestId, choice: "allow" } });
    const res = makeRes();
    await route.handler(req, res);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(writes, ["1"]);
    assert.strictEqual(permissionStore.size(), 0, "request should be popped");
    assert.ok(published.some(m =>
      m?.status === "permission-resolved" &&
      m?.choice === "allow" &&
      m?.requestId === record.requestId
    ));
  });

  it("POST /api/claude/permission maps choices to the right digit", async () => {
    const cases = [["allow", "1"], ["allow-session", "2"], ["deny", "3"]];
    for (const [choice, key] of cases) {
      const writes = [];
      ctx.sessionManager = stubSessionManagerForUuid(UUID, writes);
      routes = createClaudeFeedRoutes(ctx);
      const record = permissionStore.add({ uuid: UUID });
      const route = routeFor("POST", "/api/claude/permission");
      const res = makeRes();
      await route.handler(
        makeReq({ method: "POST", body: { requestId: record.requestId, choice } }),
        res,
      );
      assert.strictEqual(res.status, 200, `choice=${choice}`);
      assert.deepStrictEqual(writes, [key], `choice=${choice}`);
    }
  });

  it("POST /api/claude/permission with choice=dismiss never writes to the pane", async () => {
    const writes = [];
    ctx.sessionManager = stubSessionManagerForUuid(UUID, writes);
    routes = createClaudeFeedRoutes(ctx);

    const record = permissionStore.add({ uuid: UUID });
    const published = [];
    broker.subscribe(`claude/${UUID}`, (env) => published.push(env.message));

    const route = routeFor("POST", "/api/claude/permission");
    const res = makeRes();
    await route.handler(
      makeReq({ method: "POST", body: { requestId: record.requestId, choice: "dismiss" } }),
      res,
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(writes, [], "dismiss must not send a keystroke");
    assert.ok(published.some(m => m?.status === "permission-resolved" && m?.choice === "dismiss"));
    assert.strictEqual(permissionStore.size(), 0);
  });

  it("POST /api/claude/permission returns 404 for an unknown requestId", async () => {
    const route = routeFor("POST", "/api/claude/permission");
    const res = makeRes();
    await route.handler(
      makeReq({ method: "POST", body: { requestId: "nope", choice: "allow" } }),
      res,
    );
    assert.strictEqual(res.status, 404);
  });

  it("POST /api/claude/permission double-resolve is a 404, not a double-write", async () => {
    const writes = [];
    ctx.sessionManager = stubSessionManagerForUuid(UUID, writes);
    routes = createClaudeFeedRoutes(ctx);

    const record = permissionStore.add({ uuid: UUID });
    const route = routeFor("POST", "/api/claude/permission");
    const req1 = makeReq({ method: "POST", body: { requestId: record.requestId, choice: "allow" } });
    const req2 = makeReq({ method: "POST", body: { requestId: record.requestId, choice: "allow" } });
    const r1 = makeRes();
    const r2 = makeRes();
    await route.handler(req1, r1);
    await route.handler(req2, r2);

    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 404);
    assert.deepStrictEqual(writes, ["1"], "only the first resolve writes");
  });

  it("POST /api/claude/permission rejects unknown choices with 400", async () => {
    const record = permissionStore.add({ uuid: UUID });
    const route = routeFor("POST", "/api/claude/permission");
    const res = makeRes();
    await route.handler(
      makeReq({ method: "POST", body: { requestId: record.requestId, choice: "drop-nuke" } }),
      res,
    );
    assert.strictEqual(res.status, 400);
    // Bad choice must NOT pop the store — the user gets to retry.
    assert.strictEqual(permissionStore.size(), 1);
  });

  it("POST /api/claude/permission returns 404 when no live session has that uuid", async () => {
    ctx.sessionManager = { listSessions: () => ({ sessions: [] }), getSession: () => null };
    routes = createClaudeFeedRoutes(ctx);

    const record = permissionStore.add({ uuid: UUID });
    const route = routeFor("POST", "/api/claude/permission");
    const res = makeRes();
    await route.handler(
      makeReq({ method: "POST", body: { requestId: record.requestId, choice: "allow" } }),
      res,
    );
    assert.strictEqual(res.status, 404);
  });
});
