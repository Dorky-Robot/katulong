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
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { createWatchlist } from "../lib/claude-watchlist.js";
import {
  resolveWatchTarget,
  createClaudeFeedRoutes,
} from "../lib/routes/claude-feed-routes.js";
import { slugifyCwd } from "../lib/claude-transcript-discovery.js";

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

function makeCtx({ watchlist, processor, topicBroker, sessionManager, homeDir }) {
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
  const homeDir = "/home/felix";

  it("rejects an empty body", () => {
    const out = resolveWatchTarget({ body: null, homeDir });
    assert.match(out.error, /JSON object/);
  });

  it("rejects when uuid or cwd missing", () => {
    const out = resolveWatchTarget({ body: {}, homeDir });
    assert.match(out.error, /uuid, cwd/);
  });

  it("rejects an invalid uuid", () => {
    const out = resolveWatchTarget({ body: { uuid: "nope", cwd: "/x" }, homeDir });
    assert.match(out.error, /Invalid uuid/);
  });

  it("builds a transcriptPath from uuid + cwd", () => {
    const out = resolveWatchTarget({
      body: { uuid: UUID, cwd: "/Users/felix/Projects/katulong" },
      homeDir,
    });
    assert.strictEqual(out.uuid, UUID);
    assert.strictEqual(
      out.transcriptPath,
      `${homeDir}/.claude/projects/${slugifyCwd("/Users/felix/Projects/katulong")}/${UUID}.jsonl`,
    );
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

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-feed-routes-"));
    home = mkdtempSync(join(tmpdir(), "katulong-feed-routes-home-"));
    watchlist = createWatchlist({ dataDir });
    processor = makeFakeProcessor();
    broker = makeFakeBroker();
    sessionManager = { getSession: () => null };
    ctx = makeCtx({ watchlist, processor, topicBroker: broker, sessionManager, homeDir: home });
    routes = createClaudeFeedRoutes(ctx);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("exposes the expected four routes", () => {
    const keys = routes.map(r => [r.method, r.path || r.prefix]);
    assert.deepStrictEqual(keys, [
      ["POST", "/api/claude/watch"],
      ["DELETE", "/api/claude/watch/"],
      ["GET", "/api/claude/watchlist"],
      ["GET", "/api/claude/stream/"],
    ]);
  });

  it("POST /api/claude/watch adds by { uuid, cwd } and returns the entry", async () => {
    const route = routeFor("POST", "/api/claude/watch");
    const req = makeReq({ method: "POST", body: { uuid: UUID, cwd: "/Users/felix/proj" } });
    const res = makeRes();
    await route.handler(req, res);
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.chunks[0]);
    assert.strictEqual(body.uuid, UUID);
    assert.ok(body.transcriptPath.endsWith(`${UUID}.jsonl`));
    assert.strictEqual(body.lastProcessedLine, 0);

    const stored = await watchlist.get(UUID);
    assert.ok(stored);
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

  it("POST /api/claude/watch { session } — 400 when session is unknown", async () => {
    sessionManager = { getSession: () => null };
    ctx = makeCtx({ watchlist, processor, topicBroker: broker, sessionManager, homeDir: home });
    routes = createClaudeFeedRoutes(ctx);

    const route = routeFor("POST", "/api/claude/watch");
    const res = makeRes();
    await route.handler(makeReq({ method: "POST", body: { session: "ghost" } }), res);
    assert.strictEqual(res.status, 400);
    assert.match(JSON.parse(res.chunks[0]).error, /Session not found/);
  });

  it("POST /api/claude/watch { session } — 404 when session exists but has no live Claude", async () => {
    // Sparkle button should only be clickable when Claude is running, but
    // if the user somehow triggers the endpoint without a live process
    // (race: Claude just exited, stale client state), we return 404
    // rather than pretending some unrelated transcript is theirs.
    //
    // sessionManager returns a session with no tmuxName/alive, which
    // makes findLiveClaudeInPane short-circuit to null — the behavior we
    // want without shelling out to tmux/pgrep/lsof in tests.
    sessionManager = {
      getSession: (name) => name === "work" ? { name, meta: {}, alive: false } : null,
    };
    ctx = makeCtx({ watchlist, processor, topicBroker: broker, sessionManager, homeDir: home });
    routes = createClaudeFeedRoutes(ctx);

    const route = routeFor("POST", "/api/claude/watch");
    const res = makeRes();
    await route.handler(makeReq({ method: "POST", body: { session: "work" } }), res);
    assert.strictEqual(res.status, 404);
    assert.match(JSON.parse(res.chunks[0]).error, /No Claude process/);
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
});
