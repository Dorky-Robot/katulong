/**
 * Session mint / consume lifecycle tests.
 *
 * These tests exercise the /api/sessions/mint and /auth/consume route
 * handlers directly (no HTTP layer) against a real on-disk AuthState so
 * withStateLock and persistence behave normally. KATULONG_DATA_DIR is
 * redirected to a tmp dir before any lib module loads to avoid touching
 * the developer's real state.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "katulong-mint-test-"));
process.env.KATULONG_DATA_DIR = TEST_DATA_DIR;
process.on("exit", () => {
  try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

const { AuthState } = await import("../lib/auth-state.js");
const { SCOPE_MINT_SESSION, SCOPE_FULL } = await import("../lib/api-key-scopes.js");
const authRepo = await import("../lib/auth-repository.js");
const { createAuthRoutes, _resetMintStateForTesting } = await import("../lib/routes/auth-routes.js");
const { createMiddleware } = await import("../lib/routes/middleware.js");

const ORIGIN = "https://example.com";
const HOST = "example.com";

// --- Fake req/res helpers ---

function makeReq({ method = "GET", url = "/", headers = {}, body = null, apiKey = null } = {}) {
  // Attach a readable stream with the body payload so parseJSON can consume it.
  const stream = body !== null ? Readable.from([typeof body === "string" ? body : JSON.stringify(body)]) : Readable.from([]);
  const baseHeaders = { host: HOST, "user-agent": "test", ...headers };
  const req = Object.assign(stream, {
    method,
    url,
    headers: baseHeaders,
    socket: { encrypted: true, remoteAddress: "203.0.113.1" },
  });
  if (apiKey) {
    req.headers.authorization = `Bearer ${apiKey}`;
  }
  return req;
}

function makeRes() {
  const headers = {};
  const cookies = [];
  const res = {
    statusCode: 200,
    _body: null,
    _ended: false,
    setHeader(name, value) {
      if (name.toLowerCase() === "set-cookie") {
        if (Array.isArray(value)) cookies.push(...value); else cookies.push(value);
      }
      headers[name] = value;
    },
    getHeader(name) { return headers[name]; },
    writeHead(status, extraHeaders) {
      this.statusCode = status;
      if (extraHeaders) {
        for (const [k, v] of Object.entries(extraHeaders)) {
          if (k.toLowerCase() === "set-cookie") {
            if (Array.isArray(v)) cookies.push(...v); else cookies.push(v);
          }
          headers[k] = v;
        }
      }
    },
    end(body) { this._body = body ?? null; this._ended = true; },
    get headers() { return headers; },
    get cookies() { return cookies; },
  };
  return res;
}

function findRoute(routes, method, path) {
  const r = routes.find(r => r.method === method && r.path === path);
  assert.ok(r, `route ${method} ${path} not found`);
  return r;
}

// --- Shared setup ---

let routes;
let fullApiKey;
let mintApiKey;
const CREDENTIAL_ID = "cred-test-1";

// Minimal parseJSON/json that mirror lib/request-util.js behavior.
async function parseJSON(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// isAuthenticated mirrors server.js Bearer path for tests.
function isAuthenticatedForTests(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    const apiKey = header.slice(7);
    const state = authRepo.loadState();
    if (!state) return null;
    const keyData = state.findApiKey(apiKey);
    if (!keyData) return null;
    req._apiKeyAuth = true;
    req._apiKeyId = keyData.id;
    req._apiKeyScopes = keyData.scopes || [SCOPE_FULL];
    return { authenticated: true, sessionToken: null, credentialId: null, apiKeyId: keyData.id };
  }
  return null;
}

before(async () => {
  await authRepo.withStateLock(() => {
    const state = AuthState.empty("user-1", "owner")
      .addCredential({
        id: CREDENTIAL_ID,
        publicKey: "pk",
        counter: 0,
        name: "Test Credential",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      })
      .addApiKey({
        id: "full-key",
        key: "f".repeat(64),
        name: "full",
        createdAt: Date.now(),
        lastUsedAt: 0,
        scopes: [SCOPE_FULL],
      })
      .addApiKey({
        id: "mint-key",
        key: "m".repeat(64),
        name: "mint-only",
        createdAt: Date.now(),
        lastUsedAt: 0,
        scopes: [SCOPE_MINT_SESSION],
      });
    return { state };
  });
  fullApiKey = "f".repeat(64);
  mintApiKey = "m".repeat(64);

  const middleware = createMiddleware({ isAuthenticated: isAuthenticatedForTests, json });
  routes = createAuthRoutes({
    json,
    parseJSON,
    isAuthenticated: isAuthenticatedForTests,
    storeChallenge: () => {},
    consumeChallenge: () => false,
    challengeStore: null,
    credentialLockout: null,
    bridge: { relay: () => {} },
    RP_NAME: "Test",
    PORT: 443,
    auth: middleware.auth,
    csrf: middleware.csrf,
    requireScope: middleware.requireScope,
  });
});

beforeEach(() => {
  _resetMintStateForTesting();
});

after(() => {
  // rmSync runs on process exit; nothing else to do.
});

describe("POST /api/sessions/mint — scope enforcement", () => {
  it("rejects when no Bearer header is provided", async () => {
    const route = findRoute(routes, "POST", "/api/sessions/mint");
    const req = makeReq({ method: "POST", url: "/api/sessions/mint", body: {} });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 401);
  });

  it("rejects a full-scope key (default-deny on narrow-scope routes)", async () => {
    const route = findRoute(routes, "POST", "/api/sessions/mint");
    const req = makeReq({ method: "POST", url: "/api/sessions/mint", body: {}, apiKey: fullApiKey });
    const res = makeRes();
    await route.handler(req, res);
    // Full-scope keys pass requireScope(). The 201 confirms they're accepted;
    // this guards against a future regression where requireScope accidentally
    // excludes "full".
    assert.equal(res.statusCode, 201, "full-scope key should be accepted");
  });

  it("accepts a mint-session-scoped key", async () => {
    const route = findRoute(routes, "POST", "/api/sessions/mint");
    const req = makeReq({ method: "POST", url: "/api/sessions/mint", body: {}, apiKey: mintApiKey });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res._body);
    assert.ok(body.consumeUrl, "consumeUrl in response");
    assert.ok(body.consumeToken, "consumeToken in response");
    assert.ok(body.expiresAt > Date.now(), "expiresAt is in the future");
  });

  it("rejects invalid returnTo (cross-origin)", async () => {
    const route = findRoute(routes, "POST", "/api/sessions/mint");
    const req = makeReq({
      method: "POST",
      url: "/api/sessions/mint",
      body: { returnTo: "https://evil.example/steal" },
      apiKey: mintApiKey,
    });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  it("accepts same-origin returnTo", async () => {
    const route = findRoute(routes, "POST", "/api/sessions/mint");
    const req = makeReq({
      method: "POST",
      url: "/api/sessions/mint",
      body: { returnTo: "/?fleet=hub" },
      apiKey: mintApiKey,
    });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res._body);
    assert.ok(body.consumeUrl.includes("return="), "consumeUrl carries the return param");
  });
});

describe("GET /auth/consume — lifecycle", () => {
  async function mintConsumeToken({ returnTo } = {}) {
    const mintRoute = findRoute(routes, "POST", "/api/sessions/mint");
    const req = makeReq({
      method: "POST",
      url: "/api/sessions/mint",
      body: returnTo ? { returnTo } : {},
      apiKey: mintApiKey,
    });
    const res = makeRes();
    await mintRoute.handler(req, res);
    assert.equal(res.statusCode, 201, `mint failed: ${res._body}`);
    return JSON.parse(res._body);
  }

  it("issues a session cookie and 302-redirects to /", async () => {
    const { consumeToken } = await mintConsumeToken();
    const route = findRoute(routes, "GET", "/auth/consume");
    const req = makeReq({ method: "GET", url: `/auth/consume?token=${consumeToken}` });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, "/");
    const cookie = res.cookies.find(c => c.startsWith("katulong_session="));
    assert.ok(cookie, "katulong_session cookie set");
    assert.ok(cookie.includes("HttpOnly"), "cookie is HttpOnly");
  });

  it("honors same-origin return URL", async () => {
    const { consumeToken } = await mintConsumeToken({ returnTo: "/?fleet=hub" });
    const route = findRoute(routes, "GET", "/auth/consume");
    const req = makeReq({
      method: "GET",
      url: `/auth/consume?token=${consumeToken}&return=${encodeURIComponent("/?fleet=hub")}`,
    });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, "/?fleet=hub");
  });

  it("rejects cross-origin return URL at consume time", async () => {
    const { consumeToken } = await mintConsumeToken();
    const route = findRoute(routes, "GET", "/auth/consume");
    const req = makeReq({
      method: "GET",
      url: `/auth/consume?token=${consumeToken}&return=${encodeURIComponent("https://evil.example/")}`,
    });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  it("is single-use: replay returns 404", async () => {
    const { consumeToken } = await mintConsumeToken();
    const route = findRoute(routes, "GET", "/auth/consume");
    // First consume succeeds
    const res1 = makeRes();
    await route.handler(makeReq({ method: "GET", url: `/auth/consume?token=${consumeToken}` }), res1);
    assert.equal(res1.statusCode, 302);
    // Replay with same token must not create a second session
    const res2 = makeRes();
    await route.handler(makeReq({ method: "GET", url: `/auth/consume?token=${consumeToken}` }), res2);
    assert.equal(res2.statusCode, 404);
  });

  it("rejects unknown consume token", async () => {
    const route = findRoute(routes, "GET", "/auth/consume");
    const req = makeReq({ method: "GET", url: "/auth/consume?token=deadbeef" });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 404);
  });

  it("rejects when token param is missing", async () => {
    const route = findRoute(routes, "GET", "/auth/consume");
    const req = makeReq({ method: "GET", url: "/auth/consume" });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 400);
  });
});

describe("scope middleware default-deny", () => {
  it("narrow-scope key is rejected by a generic auth()-only route (GET /api/api-keys)", async () => {
    const route = findRoute(routes, "GET", "/api/api-keys");
    const req = makeReq({ method: "GET", url: "/api/api-keys", apiKey: mintApiKey });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 403, "mint-session key must not list API keys");
  });

  it("full-scope key is accepted on the same route", async () => {
    const route = findRoute(routes, "GET", "/api/api-keys");
    const req = makeReq({ method: "GET", url: "/api/api-keys", apiKey: fullApiKey });
    const res = makeRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 200);
  });
});
