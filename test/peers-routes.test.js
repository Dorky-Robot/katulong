/**
 * createPeersRoutes — list, sessions-proxy, credentials, and PUT.
 *
 * The routes are the only path in this codebase that takes a
 * cross-instance api key out of config and uses it on the wire. A
 * regression here can leak keys to unintended callers, send keys to
 * unconfigured peer URLs (SSRF), or quietly hand back a stale or
 * partial peer list. Each test pins one of those failure modes so we
 * can see them in CI rather than during a debugging session at 1am.
 *
 * Wire shape under test
 *   GET  /api/peers              — public-shape list (no apiKey)
 *   GET  /api/peers/:id/sessions — proxies peer.url/sessions with
 *                                   Authorization: Bearer <apiKey>
 *   GET  /api/peers/:id/credentials — returns the apiKey to the
 *                                   already-authenticated caller
 *   PUT  /api/config/peers       — replaces the peers config
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPeersRoutes } from "../lib/routes/peers-routes.js";

// ── Test doubles ──────────────────────────────────────────────────
function makeJson() {
  const calls = [];
  function json(res, status, body) {
    calls.push({ status, body });
    res._lastStatus = status;
    res._lastBody = body;
  }
  return { json, calls };
}

function makeRes() {
  return { _lastStatus: null, _lastBody: null };
}

// passthrough auth/csrf so we exercise the route handlers directly.
const passthrough = (h) => h;

function makeConfigManager(initial) {
  // initial: { peers: [{id,url,apiKey,label?}, ...] }
  let peers = initial?.peers ? [...initial.peers] : [];
  return {
    getPeers: () => peers.map(({ id, url, label }) => ({ id, url, label: label || id })),
    getPeerById: (id) => peers.find((p) => p.id === id) || null,
    setPeers: async (arr) => {
      if (arr === null) { peers = []; return; }
      if (!Array.isArray(arr)) throw new Error("peers must be an array or null");
      // Mirror the real validator's "id must match" rule so the
      // PUT-failure test can exercise it without coupling to the full
      // ConfigManager surface.
      for (const p of arr) {
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(p?.id || "")) {
          throw new Error("peer id must match [a-zA-Z0-9._-]{1,64}");
        }
      }
      peers = [...arr];
    },
  };
}

function findRoute(routes, method, path) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.path && r.path === path) return { route: r, param: null };
    if (r.prefix && path.startsWith(r.prefix)) {
      return { route: r, param: path.slice(r.prefix.length) };
    }
  }
  return null;
}

// ── GET /api/peers ────────────────────────────────────────────────
describe("GET /api/peers", () => {
  let cm;
  let json;
  let routes;

  beforeEach(() => {
    cm = makeConfigManager({
      peers: [
        { id: "mini",  url: "https://m.example", apiKey: "k".repeat(32) },
        { id: "prime", url: "https://p.example", apiKey: "K".repeat(32), label: "Prime · home" },
      ],
    });
    ({ json } = makeJson());
    routes = createPeersRoutes({
      json, parseJSON: async () => null,
      configManager: cm, auth: passthrough, csrf: passthrough,
      fetchFn: async () => { throw new Error("not used in this test"); },
    });
  });

  it("returns the peer list without exposing apiKey", () => {
    const { route } = findRoute(routes, "GET", "/api/peers");
    const res = makeRes();
    route.handler({}, res);
    assert.equal(res._lastStatus, 200);
    assert.equal(res._lastBody.peers.length, 2);
    for (const p of res._lastBody.peers) {
      assert.equal(p.apiKey, undefined, "apiKey must NOT appear in /api/peers response");
      assert.ok(p.id);
      assert.ok(p.url);
    }
  });
});

// ── GET /api/peers/:id/credentials ─────────────────────────────────
describe("GET /api/peers/:id/credentials", () => {
  let cm, json, routes;

  beforeEach(() => {
    cm = makeConfigManager({
      peers: [{ id: "mini", url: "https://m.example", apiKey: "k".repeat(32), label: "Mini" }],
    });
    ({ json } = makeJson());
    routes = createPeersRoutes({
      json, parseJSON: async () => null,
      configManager: cm, auth: passthrough, csrf: passthrough,
      fetchFn: async () => { throw new Error("not used in this test"); },
    });
  });

  it("returns peerUrl, apiKey, and label for a configured peer", async () => {
    const { route, param } = findRoute(routes, "GET", "/api/peers/mini/credentials");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.equal(res._lastStatus, 200);
    assert.equal(res._lastBody.peerUrl, "https://m.example");
    assert.equal(res._lastBody.apiKey, "k".repeat(32));
    assert.equal(res._lastBody.label, "Mini");
  });

  it("returns 404 for an unknown peer id", async () => {
    const { route, param } = findRoute(routes, "GET", "/api/peers/unknown/credentials");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.equal(res._lastStatus, 404);
  });

  it("returns 400 for an invalid peer id (special chars not allowed)", async () => {
    // The id pattern restricts to filename-safe chars. A request with
    // chars outside that set must be rejected explicitly with 400 so
    // probing is visible in logs (vs. a generic 404 that looks like
    // any other miss). The regex is `[a-zA-Z0-9._-]{1,64}` — chars
    // like `@`, `%`, `=` must not pass through.
    //
    // Note: `..bad..` IS in the allowed alphabet (periods are fine)
    // and would 404 because the lookup misses, not 400. There's no
    // path-traversal risk because the id is only used as a lookup
    // key, never concatenated into a filesystem path.
    const { route, param } = findRoute(routes, "GET", "/api/peers/bad@id/credentials");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.equal(res._lastStatus, 400);
  });
});

// ── GET /api/peers/:id/sessions (proxy) ────────────────────────────
describe("GET /api/peers/:id/sessions — proxy behavior", () => {
  function setup(fetchFn) {
    const cm = makeConfigManager({
      peers: [{ id: "mini", url: "https://m.example", apiKey: "k".repeat(32) }],
    });
    const { json } = makeJson();
    const routes = createPeersRoutes({
      json, parseJSON: async () => null,
      configManager: cm, auth: passthrough, csrf: passthrough,
      fetchFn,
    });
    return { routes };
  }

  it("calls peer.url/sessions with Bearer authorization", async () => {
    let captured = null;
    const fetchFn = async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        status: 200,
        json: async () => ({ sessions: [{ name: "kat_a", alive: true }] }),
      };
    };
    const { routes } = setup(fetchFn);
    const { route, param } = findRoute(routes, "GET", "/api/peers/mini/sessions");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.equal(captured.url, "https://m.example/sessions");
    assert.equal(captured.opts.headers.Authorization, `Bearer ${"k".repeat(32)}`);
    assert.equal(res._lastStatus, 200);
    assert.equal(res._lastBody.sessions.length, 1);
    assert.equal(res._lastBody.sessions[0].name, "kat_a");
  });

  it("strips fields the peer adds beyond {name, alive, title}", async () => {
    // A future peer might add a sensitive metadata field. The proxy
    // forwards only the fields the picker UI uses — anything else
    // gets dropped at this boundary.
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sessions: [{
          name: "kat_a", alive: true,
          secretInternalField: "hush",
          autoTitle: "summary",
        }],
      }),
    });
    const { routes } = setup(fetchFn);
    const { route, param } = findRoute(routes, "GET", "/api/peers/mini/sessions");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.deepEqual(Object.keys(res._lastBody.sessions[0]).sort(), ["alive", "name", "title"]);
    assert.equal(res._lastBody.sessions[0].title, "summary");
    assert.equal(res._lastBody.sessions[0].secretInternalField, undefined);
  });

  it("accepts a bare-array response shape from the peer", async () => {
    // Older katulong versions answered /sessions with a bare array
    // (no `sessions` envelope). Don't break against those.
    const fetchFn = async () => ({
      ok: true, status: 200,
      json: async () => ([{ name: "kat_a", alive: true }]),
    });
    const { routes } = setup(fetchFn);
    const { route, param } = findRoute(routes, "GET", "/api/peers/mini/sessions");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.equal(res._lastBody.sessions.length, 1);
  });

  it("returns 502 when the peer is unreachable", async () => {
    const fetchFn = async () => { const e = new Error("ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; };
    const { routes } = setup(fetchFn);
    const { route, param } = findRoute(routes, "GET", "/api/peers/mini/sessions");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.equal(res._lastStatus, 502);
  });

  it("returns 502 with a clean message when peer returns 401", async () => {
    // The peer-side api key was rotated and we're using a stale one.
    // Don't surface peer error bodies to the picker UI — we don't trust
    // the peer to render safely in our own UI.
    const fetchFn = async () => ({
      ok: false, status: 401,
      json: async () => ({ secretError: "leak" }),
    });
    const { routes } = setup(fetchFn);
    const { route, param } = findRoute(routes, "GET", "/api/peers/mini/sessions");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.equal(res._lastStatus, 502);
    assert.equal(res._lastBody.secretError, undefined, "peer error body must NOT leak through proxy");
  });

  it("returns 502 when peer returns invalid JSON", async () => {
    const fetchFn = async () => ({
      ok: true, status: 200,
      json: async () => { throw new Error("invalid json"); },
    });
    const { routes } = setup(fetchFn);
    const { route, param } = findRoute(routes, "GET", "/api/peers/mini/sessions");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.equal(res._lastStatus, 502);
  });

  it("returns 404 for an unconfigured peer id", async () => {
    const fetchFn = async () => { throw new Error("must not fetch when peer is unknown"); };
    const { routes } = setup(fetchFn);
    const { route, param } = findRoute(routes, "GET", "/api/peers/unknown/sessions");
    const res = makeRes();
    await route.handler({}, res, param);
    assert.equal(res._lastStatus, 404);
  });
});

// ── PUT /api/config/peers ──────────────────────────────────────────
describe("PUT /api/config/peers", () => {
  function setup(initial) {
    const cm = makeConfigManager(initial || {});
    const { json } = makeJson();
    const routes = createPeersRoutes({
      json,
      parseJSON: async (req) => req._body,
      configManager: cm, auth: passthrough, csrf: passthrough,
      fetchFn: async () => { throw new Error("not used in this test"); },
    });
    return { routes, cm };
  }

  it("replaces the peers list and returns the public view", async () => {
    const { routes, cm } = setup();
    const { route } = findRoute(routes, "PUT", "/api/config/peers");
    const req = { _body: { peers: [{ id: "mini", url: "https://m.example", apiKey: "k".repeat(32) }] } };
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res._lastStatus, 200);
    assert.equal(res._lastBody.peers.length, 1);
    assert.equal(res._lastBody.peers[0].apiKey, undefined, "PUT response must not echo the apiKey");
    // Storage is updated for subsequent reads
    assert.equal(cm.getPeerById("mini").apiKey, "k".repeat(32));
  });

  it("returns 400 when body is missing peers field", async () => {
    const { routes } = setup();
    const { route } = findRoute(routes, "PUT", "/api/config/peers");
    const res = makeRes();
    await route.handler({ _body: { peersWrongName: [] } }, res);
    assert.equal(res._lastStatus, 400);
  });

  it("returns 400 with the validator's message when an entry is bad", async () => {
    const { routes } = setup();
    const { route } = findRoute(routes, "PUT", "/api/config/peers");
    const res = makeRes();
    await route.handler(
      { _body: { peers: [{ id: "bad/id", url: "https://x.example", apiKey: "k".repeat(32) }] } },
      res,
    );
    assert.equal(res._lastStatus, 400);
    assert.match(res._lastBody.error, /peer id must match/);
  });

  it("clears peers when body is { peers: null }", async () => {
    const { routes, cm } = setup({
      peers: [{ id: "mini", url: "https://m.example", apiKey: "k".repeat(32) }],
    });
    const { route } = findRoute(routes, "PUT", "/api/config/peers");
    const res = makeRes();
    await route.handler({ _body: { peers: null } }, res);
    assert.equal(res._lastStatus, 200);
    assert.deepEqual(cm.getPeers(), []);
  });
});
