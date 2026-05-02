/**
 * createUpgradeHandler — Origin validation matrix, with the cross-instance
 * api-key bypass.
 *
 * Why these tests exist
 *   The cross-instance-tile spike intentionally relaxes Origin enforcement
 *   when authentication came from an api-key (Bearer header or
 *   `?api_key=` query). This file pins:
 *     1. Cookie-authenticated upgrades from a foreign Origin still get
 *        rejected (no CSRF regression).
 *     2. api-key-authenticated upgrades from a foreign Origin pass.
 *     3. Auth still runs first — an upgrade with a malformed/missing
 *        cookie is rejected before Origin is even consulted.
 *
 * The handler is constructed with stub injectables so we can drive it
 * deterministically. We mark req._apiKeyAuth on the way through `isAuthenticated`
 * just like server.js does, since validateUpgradeOrigin reads that flag.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createUpgradeHandler } from "../lib/server-upgrade.js";

function makeSocket() {
  const calls = { writes: [], destroyed: false };
  return {
    write(s) { calls.writes.push(s); },
    destroy() { calls.destroyed = true; },
    remoteAddress: "203.0.113.5",  // documentation-only IP
    _calls: calls,
  };
}

function makeReq({ url = "/", origin = null, host = "katulong.example", apiKeyAuth = false }) {
  return {
    url,
    headers: {
      ...(origin ? { origin } : {}),
      host,
    },
    socket: { remoteAddress: "203.0.113.5" },
    ...(apiKeyAuth ? { _apiKeyAuth: true } : {}),
  };
}

function buildHandler({ isAuthenticatedImpl, wssHandleUpgrade } = {}) {
  // Use a mutable list so individual tests can opt into / out of state
  // checking. Defaults: auth always passes, no proxy/local bypass,
  // never trusted, no port-proxy paths in play.
  const wsManagerCalls = [];
  const wssHandleUpgradeCalls = [];
  const handler = createUpgradeHandler({
    wss: {
      handleUpgrade(req, socket, head, cb) {
        wssHandleUpgradeCalls.push({ req, socket, head });
        if (wssHandleUpgrade) wssHandleUpgrade(req, socket, head, cb);
        // Default: invoke the cb with a fake ws so the rest of the path runs
        cb({ close() {} });
      },
    },
    isAuthenticated: isAuthenticatedImpl ||
      (() => ({ authenticated: true, sessionToken: null, credentialId: null })),
    isTrustedProxy: () => false,
    loadState: () => ({ isValidLoginToken: () => true }),
    configManager: { getPortProxyEnabled: () => true },
    proxyWebSocket: () => {},
    wsManager: {
      handleConnection(ws, auth) {
        wsManagerCalls.push({ ws, auth });
      },
    },
  });
  return { handler, wsManagerCalls, wssHandleUpgradeCalls };
}

describe("createUpgradeHandler — cookie auth + Origin matching", () => {
  it("accepts an upgrade with matching Origin and host", () => {
    const { handler, wsManagerCalls } = buildHandler();
    const req = makeReq({
      origin: "https://katulong.example",
      host: "katulong.example",
    });
    const socket = makeSocket();

    handler(req, socket, Buffer.alloc(0));

    assert.equal(wsManagerCalls.length, 1, "should reach wsManager");
    assert.equal(socket._calls.destroyed, false);
  });

  it("rejects an upgrade when Origin host does not match Host", () => {
    // This is the CSRF guard: a cookie-bearing user on attacker.example
    // must not be able to upgrade to katulong.example via a hidden form.
    const { handler, wsManagerCalls } = buildHandler();
    const req = makeReq({
      origin: "https://attacker.example",
      host: "katulong.example",
    });
    const socket = makeSocket();

    handler(req, socket, Buffer.alloc(0));

    assert.equal(wsManagerCalls.length, 0, "must not reach wsManager");
    assert.equal(socket._calls.destroyed, true);
    assert.ok(
      socket._calls.writes.some((w) => w.includes("403")),
      "should write 403",
    );
  });

  it("rejects an upgrade with no Origin header", () => {
    // Legitimate browsers always send Origin on cross-origin WS. A
    // missing Origin from a non-local request is a same-origin lie or
    // a non-browser caller — reject.
    const { handler, wsManagerCalls } = buildHandler();
    const req = makeReq({ origin: null, host: "katulong.example" });
    const socket = makeSocket();

    handler(req, socket, Buffer.alloc(0));

    assert.equal(wsManagerCalls.length, 0);
    assert.equal(socket._calls.destroyed, true);
  });
});

describe("createUpgradeHandler — api-key auth bypasses Origin", () => {
  // When isAuthenticated() returns success and sets req._apiKeyAuth=true
  // (the convention server.js uses), the upgrade handler must let the
  // request through even if Origin doesn't match Host. This is the whole
  // point of the cross-instance spike: a browser tile on
  // katulong-mini.example connects to katulong-prime.example, and the
  // cross-origin Origin header is the *expected* shape, not an attack.

  it("accepts a foreign-Origin upgrade when api-key auth was used", () => {
    const { handler, wsManagerCalls } = buildHandler({
      isAuthenticatedImpl: (req) => {
        req._apiKeyAuth = true;
        return { authenticated: true, sessionToken: null, credentialId: null, apiKeyId: "k1" };
      },
    });
    const req = makeReq({
      url: "/?api_key=secret",
      origin: "https://katulong-mini.example",
      host: "katulong-prime.example",
    });
    const socket = makeSocket();

    handler(req, socket, Buffer.alloc(0));

    assert.equal(wsManagerCalls.length, 1, "should reach wsManager");
    assert.equal(socket._calls.destroyed, false);
  });

  it("accepts an api-key upgrade with no Origin header at all", () => {
    // Non-browser callers (a peer-link daemon, curl) won't send Origin.
    // api-key auth treats that as fine.
    const { handler, wsManagerCalls } = buildHandler({
      isAuthenticatedImpl: (req) => {
        req._apiKeyAuth = true;
        return { authenticated: true, sessionToken: null, credentialId: null, apiKeyId: "k1" };
      },
    });
    const req = makeReq({
      url: "/?api_key=secret",
      origin: null,
      host: "katulong-prime.example",
    });
    const socket = makeSocket();

    handler(req, socket, Buffer.alloc(0));

    assert.equal(wsManagerCalls.length, 1);
    assert.equal(socket._calls.destroyed, false);
  });

  it("does NOT bypass Origin when isAuthenticated returns success WITHOUT setting _apiKeyAuth", () => {
    // Belt-and-braces: the bypass key is the explicit `_apiKeyAuth`
    // flag, not just "any authenticated request." A cookie session
    // landing here from a foreign Origin must still be rejected.
    const { handler, wsManagerCalls } = buildHandler({
      isAuthenticatedImpl: () => ({
        authenticated: true,
        sessionToken: "session-tok",
        credentialId: "cred-1",
      }),
    });
    const req = makeReq({
      origin: "https://attacker.example",
      host: "katulong-prime.example",
    });
    const socket = makeSocket();

    handler(req, socket, Buffer.alloc(0));

    assert.equal(wsManagerCalls.length, 0, "cookie auth must still need same-Origin");
    assert.equal(socket._calls.destroyed, true);
  });
});

describe("createUpgradeHandler — auth runs before Origin check", () => {
  it("rejects with 401 when isAuthenticated returns null, even with matching Origin", () => {
    // Order matters: 401 before 403. If we 403'd first we'd be leaking
    // information about which requests would have been authenticated.
    const { handler, wsManagerCalls } = buildHandler({
      isAuthenticatedImpl: () => null,
    });
    const req = makeReq({
      origin: "https://katulong.example",
      host: "katulong.example",
    });
    const socket = makeSocket();

    handler(req, socket, Buffer.alloc(0));

    assert.equal(wsManagerCalls.length, 0);
    assert.equal(socket._calls.destroyed, true);
    assert.ok(
      socket._calls.writes.some((w) => w.includes("401")),
      "should write 401, not 403",
    );
  });
});
