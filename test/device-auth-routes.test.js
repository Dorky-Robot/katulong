/**
 * Device-auth route tests — the status-poll endpoint's issuance gates.
 *
 * Three behaviors guard session issuance on GET /auth/device-auth/status:
 *
 *   1. UA binding — the requestId is broadcast to every authenticated WS
 *      client (the approval UI needs it), so polls from a different
 *      browser than the one that created the request must not receive a
 *      session. They see "expired" and the real device keeps working.
 *   2. Single issuance — two concurrent polls racing past the approved
 *      check must mint exactly one login token (the `consumed` flag is
 *      set synchronously before the first await).
 *   3. Null-state retry — if auth state is unavailable the request must
 *      survive (503, no delete) so the approved device can poll again,
 *      instead of being told "approved" with no cookie and no recovery.
 *
 * withStateLock / createLoginToken are mocked at the module boundary so
 * the tests drive the handler directly with fake req/res objects.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { Readable } from "node:stream";

const authModuleUrl = new URL("../lib/auth.js", import.meta.url).href;

let stateAvailable = true;
let loginTokensCreated = 0;
let stateLockDelayMs = 0;

mock.module(authModuleUrl, {
  namedExports: {
    loadState: () => null,
    isSetup: () => true,
    withStateLock: async (modifier) => {
      if (stateLockDelayMs > 0) {
        await new Promise((r) => setTimeout(r, stateLockDelayMs));
      }
      const currentState = stateAvailable
        ? {
            pruneExpired() { return this; },
            addLoginToken() { return this; },
          }
        : null;
      const result = await modifier(currentState);
      return result || {};
    },
    createLoginToken: () => {
      loginTokensCreated++;
      return {
        token: `tok-${loginTokensCreated}`,
        expiry: Date.now() + 1000,
        csrfToken: "csrf",
        lastActivityAt: Date.now(),
      };
    },
    generateRegistrationOpts: async () => ({ challenge: "c" }),
    generateAuthOpts: async () => ({ challenge: "c" }),
    // Unused by these tests but imported by modules in the load graph
    // (auth-handlers.js) — the mock must provide every named export.
    saveState: () => {},
    _invalidateCache: () => {},
    verifyRegistration: async () => ({ verified: false }),
    verifyAuth: async () => ({ verified: false }),
    validateSession: () => false,
    refreshSessionActivity: async () => {},
    pruneExpiredSessions: (s) => s,
  },
});

const { createAuthRoutes } = await import("../lib/routes/auth-routes.js");

// createAuthRoutes destructures ctx once at creation, so parseJSON must
// read a mutable variable rather than be swapped on the ctx object later.
let nextParsedBody = {};

function makeCtx(captured) {
  return {
    json: (res, status, body) => { captured.push({ status, body, cookies: res._cookies }); },
    parseJSON: async () => nextParsedBody,
    isAuthenticated: () => true,
    storeChallenge: () => {},
    consumeChallenge: () => true,
    challengeStore: {},
    credentialLockout: { isLocked: () => ({ locked: false }) },
    bridge: { relay: () => {} },
    RP_NAME: "test",
    PORT: 0,
    auth: (h) => h,
    csrf: (h) => h,
  };
}

function findRoute(routes, method, path) {
  return routes.find((r) => r.method === method && r.path === path);
}

function makeReq({ url = "/", userAgent = "TestBrowser/1.0" } = {}) {
  const req = Readable.from([]);
  req.url = url;
  req.headers = { "user-agent": userAgent };
  req.socket = { remoteAddress: "127.0.0.1", encrypted: false };
  return req;
}

function makeRes() {
  return {
    _cookies: [],
    setHeader(name, value) {
      if (name === "Set-Cookie") {
        this._cookies = Array.isArray(value) ? [...value] : [value];
      }
    },
    getHeader(name) {
      if (name === "Set-Cookie") return this._cookies.length ? this._cookies : undefined;
      return undefined;
    },
  };
}

async function createRequest(routes, captured, userAgent) {
  const route = findRoute(routes, "POST", "/auth/device-auth/request");
  await route.handler(makeReq({ userAgent }), makeRes());
  const { body } = captured.pop();
  return body.requestId;
}

describe("device-auth status endpoint", () => {
  let captured, routes, ctx;

  beforeEach(() => {
    stateAvailable = true;
    loginTokensCreated = 0;
    stateLockDelayMs = 0;
    captured = [];
    ctx = makeCtx(captured);
    routes = createAuthRoutes(ctx);
  });

  async function createAndApprove(userAgent = "TestBrowser/1.0") {
    const requestId = await createRequest(routes, captured, userAgent);
    nextParsedBody = { requestId };
    const approveRoute = findRoute(routes, "POST", "/auth/device-auth/approve");
    const req = makeReq({});
    req.headers.cookie = "";
    await approveRoute.handler(req, makeRes());
    captured.pop(); // discard approve response
    return requestId;
  }

  function pollStatus(requestId, userAgent = "TestBrowser/1.0") {
    const statusRoute = findRoute(routes, "GET", "/auth/device-auth/status");
    return statusRoute.handler(
      makeReq({ url: `/auth/device-auth/status?id=${requestId}`, userAgent }),
      makeRes(),
    );
  }

  it("issues a session cookie to the requesting browser after approval", async () => {
    const requestId = await createAndApprove();
    await pollStatus(requestId);
    const { status, body, cookies } = captured.pop();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, "approved");
    assert.strictEqual(cookies.length, 1);
    assert.match(cookies[0], /katulong_session=tok-1/);
  });

  it("reports expired to a different User-Agent without deleting the request", async () => {
    const requestId = await createAndApprove("RealPhone/1.0");

    await pollStatus(requestId, "AttackerBrowser/9.9");
    const attacker = captured.pop();
    assert.strictEqual(attacker.body.status, "expired");
    assert.strictEqual(attacker.cookies.length, 0, "no cookie for mismatched UA");
    assert.strictEqual(loginTokensCreated, 0);

    // The real device still completes the flow afterwards.
    await pollStatus(requestId, "RealPhone/1.0");
    const real = captured.pop();
    assert.strictEqual(real.body.status, "approved");
    assert.strictEqual(real.cookies.length, 1);
  });

  it("mints exactly one login token for two concurrent polls", async () => {
    const requestId = await createAndApprove();
    stateLockDelayMs = 20; // hold the first poll inside withStateLock

    await Promise.all([pollStatus(requestId), pollStatus(requestId)]);

    assert.strictEqual(loginTokensCreated, 1, "second racer must not mint a token");
    const second = captured.pop();
    const first = captured.pop();
    assert.strictEqual(first.body.status, "approved");
    assert.strictEqual(second.body.status, "approved");
    const cookieCount = first.cookies.length + second.cookies.length;
    assert.strictEqual(cookieCount, 1, "exactly one response carries the cookie");
  });

  it("returns 503 and keeps the request when auth state is unavailable", async () => {
    const requestId = await createAndApprove();

    stateAvailable = false;
    await pollStatus(requestId);
    const failed = captured.pop();
    assert.strictEqual(failed.status, 503);
    assert.strictEqual(failed.cookies.length, 0);

    // State recovers — the same request must still be claimable.
    stateAvailable = true;
    await pollStatus(requestId);
    const retried = captured.pop();
    assert.strictEqual(retried.status, 200);
    assert.strictEqual(retried.body.status, "approved");
    assert.strictEqual(retried.cookies.length, 1);
  });

  it("reports expired for an unknown requestId", async () => {
    await pollStatus("00000000-0000-0000-0000-000000000000");
    const { body } = captured.pop();
    assert.strictEqual(body.status, "expired");
  });
});
