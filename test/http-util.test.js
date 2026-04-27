import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import {
  parseCookies,
  setSessionCookie,
  getOriginAndRpID,
  isPublicPath,
  createChallengeStore,
  escapeAttr,
  getCspHeaders,
  getCsrfToken,
  validateCsrfToken,
  isAllowedCorsOrigin,
  isHttpsConnection,
} from "../lib/http-util.js";
import { AuthState } from "../lib/auth-state.js";

describe("parseCookies", () => {
  it("returns empty map for null/undefined", () => {
    assert.equal(parseCookies(null).size, 0);
    assert.equal(parseCookies(undefined).size, 0);
  });

  it("returns empty map for empty string", () => {
    assert.equal(parseCookies("").size, 0);
  });

  it("parses a single cookie", () => {
    const map = parseCookies("session=abc123");
    assert.equal(map.get("session"), "abc123");
    assert.equal(map.size, 1);
  });

  it("parses multiple cookies", () => {
    const map = parseCookies("a=1; b=2; c=3");
    assert.equal(map.get("a"), "1");
    assert.equal(map.get("b"), "2");
    assert.equal(map.get("c"), "3");
  });

  it("trims whitespace around keys and values", () => {
    const map = parseCookies("  foo = bar ; baz = qux ");
    assert.equal(map.get("foo"), "bar");
    assert.equal(map.get("baz"), "qux");
  });

  it("handles values containing =", () => {
    const map = parseCookies("token=abc=def=ghi");
    assert.equal(map.get("token"), "abc=def=ghi");
  });

  it("skips entries without =", () => {
    const map = parseCookies("good=value; badentry; also=ok");
    assert.equal(map.size, 2);
    assert.equal(map.get("good"), "value");
    assert.equal(map.get("also"), "ok");
  });

  it("handles cookie with empty key (=value)", () => {
    const map = parseCookies("=orphan-value");
    // After trim, key is "" — still stored in the map
    assert.equal(map.get(""), "orphan-value");
  });

  it("does not URL-decode percent-encoded values (cookies are not decoded by this parser)", () => {
    const map = parseCookies("token=hello%20world");
    assert.equal(map.get("token"), "hello%20world");
  });

  it("handles duplicate cookie names — last value wins (Map semantics)", () => {
    const map = parseCookies("session=first; session=second");
    assert.equal(map.get("session"), "second");
    assert.equal(map.size, 1);
  });

  it("handles trailing semicolon without error", () => {
    const map = parseCookies("a=1;");
    assert.equal(map.get("a"), "1");
    assert.equal(map.size, 1);
  });

  it("returns empty map for header containing only semicolons", () => {
    const map = parseCookies(";;;");
    assert.equal(map.size, 0);
  });

  it("handles very long cookie values", () => {
    const longValue = "x".repeat(4096);
    const map = parseCookies(`session=${longValue}`);
    assert.equal(map.get("session"), longValue);
    assert.equal(map.get("session").length, 4096);
  });

  it("handles unicode characters in cookie value", () => {
    const map = parseCookies("lang=日本語");
    assert.equal(map.get("lang"), "日本語");
  });

  it("handles whitespace-only key (trims to empty string)", () => {
    const map = parseCookies("   =value");
    // Key after trim is "", value is "value"
    assert.equal(map.get(""), "value");
  });
});

describe("escapeAttr", () => {
  it("escapes quotes and angle brackets", () => {
    assert.equal(escapeAttr('a"b<c>d&e'), "a&quot;b&lt;c&gt;d&amp;e");
  });

  it("passes through safe strings unchanged", () => {
    assert.equal(escapeAttr("https://192.168.1.5:3002"), "https://192.168.1.5:3002");
  });

  it("handles numbers", () => {
    assert.equal(escapeAttr(3002), "3002");
  });
});

describe("isPublicPath", () => {
  it("allows /login", () => {
    assert.ok(isPublicPath("/login"));
  });

  it("allows /login.html", () => {
    assert.ok(isPublicPath("/login.html"));
  });

  it("allows explicit auth routes", () => {
    assert.ok(isPublicPath("/auth/status"));
    assert.ok(isPublicPath("/auth/login/options"));
    assert.ok(isPublicPath("/auth/login/verify"));
    assert.ok(isPublicPath("/auth/register/options"));
    assert.ok(isPublicPath("/auth/register/verify"));
    assert.ok(isPublicPath("/auth/logout"));
  });

  it("rejects /pair (pairing removed)", () => {
    assert.ok(!isPublicPath("/pair"));
  });

  it("rejects /auth/pair/verify (pairing removed)", () => {
    assert.ok(!isPublicPath("/auth/pair/verify"));
  });

  it("rejects unknown /auth/ paths", () => {
    assert.ok(!isPublicPath("/auth/admin"));
    assert.ok(!isPublicPath("/auth/secret"));
    assert.ok(!isPublicPath("/auth/"));
  });

  it("rejects install and uninstall scripts (removed — MITM risk)", () => {
    assert.ok(!isPublicPath("/connect/install.sh"));
    assert.ok(!isPublicPath("/connect/uninstall.sh"));
  });

  it("allows static extensions", () => {
    assert.ok(isPublicPath("/style.css"));
    assert.ok(isPublicPath("/app.js"));
    assert.ok(isPublicPath("/favicon.ico"));
    assert.ok(isPublicPath("/font.woff2"));
    assert.ok(isPublicPath("/data.json"));
  });

  it("rejects protected paths", () => {
    assert.ok(!isPublicPath("/"));
    assert.ok(!isPublicPath("/sessions"));
    assert.ok(!isPublicPath("/shortcuts"));
    assert.ok(!isPublicPath("/dashboard"));
  });

  it("rejects path traversal attempts even with static extensions", () => {
    assert.ok(!isPublicPath("/../secret.json"));
    assert.ok(!isPublicPath("/../../etc/passwd.json"));
    assert.ok(!isPublicPath("/foo/../bar.css"));
    assert.ok(!isPublicPath("/foo//bar.js"));
    assert.ok(!isPublicPath("/.hidden.json"));
  });

  it("rejects root even though / has no extension", () => {
    assert.ok(!isPublicPath("/"));
  });
});

describe("getOriginAndRpID", () => {
  it("uses http when Host is localhost (dev mode)", () => {
    const req = { headers: { host: "localhost:3001" } };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "http://localhost:3001");
    assert.equal(rpID, "localhost");
  });

  it("uses https when socket is encrypted", () => {
    const req = { headers: { host: "example.com" }, socket: { encrypted: true } };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "https://example.com");
    assert.equal(rpID, "example.com");
  });

  it("ignores x-forwarded-proto for localhost (no header trust)", () => {
    const req = { headers: { host: "localhost", "x-forwarded-proto": "https" } };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "http://localhost");
    assert.equal(rpID, "localhost");
  });

  it("uses socket.encrypted regardless of x-forwarded-proto header", () => {
    const req = { headers: { host: "example.com", "x-forwarded-proto": "http" }, socket: { encrypted: true } };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "https://example.com");
    assert.equal(rpID, "example.com");
  });

  it("defaults host to localhost", () => {
    const req = { headers: {} };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "http://localhost");
    assert.equal(rpID, "localhost");
  });

  it("ignores CF-Visitor header (forgeable, not a verified signal)", () => {
    // Localhost Host stays http even with a CF header pretending https.
    const req = {
      headers: {
        host: "localhost",
        "cf-visitor": '{"scheme":"https"}'
      }
    };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "http://localhost");
    assert.equal(rpID, "localhost");
  });

  it("uses https for temporary Cloudflare tunnels (.trycloudflare.com)", () => {
    const req = { headers: { host: "test.trycloudflare.com" } };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "https://test.trycloudflare.com");
    assert.equal(rpID, "test.trycloudflare.com");
  });

  it("uses https for ngrok tunnels", () => {
    const req = { headers: { host: "test.ngrok.app" } };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "https://test.ngrok.app");
    assert.equal(rpID, "test.ngrok.app");
  });

  it("uses https for any non-loopback Host (custom-domain tunnels, no CF header needed)", () => {
    const req = {
      headers: { host: "katulong-mini.example.com" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "https://katulong-mini.example.com");
    assert.equal(rpID, "katulong-mini.example.com");
  });

  it("does NOT trust CF-Connecting-IP — Host alone determines proto", () => {
    // Localhost stays http even with a (forgeable) CF header.
    const req = {
      headers: { host: "localhost", "cf-connecting-ip": "203.0.113.1" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const { origin } = getOriginAndRpID(req);
    assert.equal(origin, "http://localhost");
  });

  it("uses https for non-loopback Host on IPv6 loopback socket", () => {
    const req = {
      headers: { host: "app.example.com" },
      socket: { remoteAddress: "::1" },
    };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "https://app.example.com");
  });
});

describe("setSessionCookie", () => {
  it("sets a cookie with correct format", () => {
    const headers = {};
    const res = {
      getHeader: (name) => headers[name],
      setHeader: (name, value) => { headers[name] = value; },
    };
    const expiry = Date.now() + 60000;
    setSessionCookie(res, "tok123", expiry);
    const cookies = headers["Set-Cookie"];
    assert.ok(Array.isArray(cookies));
    assert.equal(cookies.length, 1);
    assert.ok(cookies[0].includes("katulong_session=tok123"));
    assert.ok(cookies[0].includes("HttpOnly"));
    assert.ok(cookies[0].includes("SameSite=Lax"));
    assert.ok(cookies[0].includes("Path=/"));
    assert.ok(cookies[0].includes("Max-Age="));
  });

  it("appends to existing cookies", () => {
    const headers = { "Set-Cookie": ["existing=one"] };
    const res = {
      getHeader: (name) => headers[name],
      setHeader: (name, value) => { headers[name] = value; },
    };
    setSessionCookie(res, "tok456", Date.now() + 60000);
    const cookies = headers["Set-Cookie"];
    assert.equal(cookies.length, 2);
    assert.equal(cookies[0], "existing=one");
    assert.ok(cookies[1].includes("katulong_session=tok456"));
  });

  it("includes Secure flag when secure option is true", () => {
    const headers = {};
    const res = {
      getHeader: (name) => headers[name],
      setHeader: (name, value) => { headers[name] = value; },
    };
    setSessionCookie(res, "tok-secure", Date.now() + 60000, { secure: true });
    const cookie = headers["Set-Cookie"][0];
    assert.ok(cookie.includes("Secure"), "Cookie should include Secure flag");
  });

  it("omits Secure flag by default", () => {
    const headers = {};
    const res = {
      getHeader: (name) => headers[name],
      setHeader: (name, value) => { headers[name] = value; },
    };
    setSessionCookie(res, "tok-http", Date.now() + 60000);
    const cookie = headers["Set-Cookie"][0];
    assert.ok(!cookie.includes("Secure"), "Cookie should not include Secure flag on HTTP");
  });

  it("calculates Max-Age from expiry", () => {
    const headers = {};
    const res = {
      getHeader: (name) => headers[name],
      setHeader: (name, value) => { headers[name] = value; },
    };
    const expiry = Date.now() + 120000; // 2 minutes
    setSessionCookie(res, "tok", expiry);
    const cookie = headers["Set-Cookie"][0];
    const match = cookie.match(/Max-Age=(\d+)/);
    assert.ok(match);
    const maxAge = parseInt(match[1], 10);
    // Should be approximately 120 seconds (allow 2s tolerance)
    assert.ok(maxAge >= 118 && maxAge <= 120, `Max-Age ${maxAge} not near 120`);
  });
});

describe("createChallengeStore", () => {
  it("store + consume round-trip succeeds", () => {
    const cs = createChallengeStore(60000);
    cs.store("challenge-1");
    assert.ok(cs.consume("challenge-1"));
    cs.destroy();
  });

  it("returns false for unknown challenge", () => {
    const cs = createChallengeStore(60000);
    assert.ok(!cs.consume("nonexistent"));
    cs.destroy();
  });

  it("challenge is single-use", () => {
    const cs = createChallengeStore(60000);
    cs.store("once");
    assert.ok(cs.consume("once"));
    assert.ok(!cs.consume("once"));
    cs.destroy();
  });

  it("expired challenges are rejected", () => {
    const cs = createChallengeStore(1000);
    cs.store("exp");
    // Force-expire via test helper
    cs._expireChallenge("exp");
    assert.ok(!cs.consume("exp"));
    cs.destroy();
  });

  it("prunes expired entries during consume", () => {
    const cs = createChallengeStore(1000);
    cs.store("old");
    cs.store("current");
    // Expire "old"
    cs._expireChallenge("old");
    // Consuming "current" should prune "old"
    cs.consume("current");
    assert.ok(!cs.has("old"));
    cs.destroy();
  });

  it("periodic sweep cleans up expired challenges", () => {
    const cs = createChallengeStore(100);

    // Store some challenges
    cs.store("challenge-1");
    cs.store("challenge-2");
    cs.store("challenge-3");

    // All challenges should exist initially
    assert.equal(cs.size(), 3);

    // Manually expire all challenges
    cs._expireChallenge("challenge-1");
    cs._expireChallenge("challenge-2");
    cs._expireChallenge("challenge-3");

    // Trigger sweep manually
    cs._sweep();

    // After sweep, expired challenges should be removed
    assert.equal(cs.size(), 0, "Expired challenges should be removed by sweep");
    cs.destroy();
  });

  it("destroy() stops the sweep interval and clears challenges", () => {
    const cs = createChallengeStore(100);
    cs.store("keep");
    assert.equal(cs.size(), 1);
    cs.destroy();
    // After destroy the Map is empty
    assert.equal(cs.size(), 0, "destroy() should clear challenges");
    // Calling destroy twice should not throw
    assert.doesNotThrow(() => cs.destroy());
  });

  it("sweep removes metadata entries when parent challenge expires", () => {
    const cs = createChallengeStore(1000);
    cs.store("challenge-1");
    // Use setMeta API (not raw Map access) to associate userID with the challenge
    cs.setMeta("challenge-1", "userID", "some-user-id-string");
    assert.equal(cs.size(), 2);
    // Expire the challenge
    cs._expireChallenge("challenge-1");
    // Trigger sweep directly
    cs._sweep();
    // The expired challenge and its associated metadata should both be swept
    assert.equal(cs.size(), 0, "sweep should clean up metadata entries when challenge expires");
    cs.destroy();
  });

  it("has() returns true for valid challenge, false for expired/unknown", () => {
    const cs = createChallengeStore(60000);
    cs.store("valid");
    assert.ok(cs.has("valid"));
    assert.ok(!cs.has("nonexistent"));
    cs._expireChallenge("valid");
    assert.ok(!cs.has("valid"));
    cs.destroy();
  });

  it("size() counts challenges and metadata entries", () => {
    const cs = createChallengeStore(60000);
    assert.equal(cs.size(), 0);
    cs.store("c1");
    assert.equal(cs.size(), 1);
    cs.setMeta("c1", "userID", "u1");
    assert.equal(cs.size(), 2);
    cs.consume("c1");
    assert.equal(cs.size(), 0);
    cs.destroy();
  });
});

describe("challengeStore metadata", () => {
  it("setMeta/getMeta round-trip succeeds", () => {
    const cs = createChallengeStore(60000);
    cs.store("challenge-1");
    cs.setMeta("challenge-1", "userID", "user-abc");
    assert.equal(cs.getMeta("challenge-1", "userID"), "user-abc");
    cs.destroy();
  });

  it("getMeta returns undefined for unknown key", () => {
    const cs = createChallengeStore(60000);
    cs.store("challenge-1");
    assert.equal(cs.getMeta("challenge-1", "userID"), undefined);
    cs.destroy();
  });

  it("deleteMeta removes metadata entry", () => {
    const cs = createChallengeStore(60000);
    cs.store("challenge-1");
    cs.setMeta("challenge-1", "userID", "user-abc");
    cs.deleteMeta("challenge-1", "userID");
    assert.equal(cs.getMeta("challenge-1", "userID"), undefined);
    cs.destroy();
  });

  it("sweep cleans up expired challenge metadata", () => {
    const cs = createChallengeStore(1000);
    cs.store("challenge-1");
    cs.setMeta("challenge-1", "userID", "user-abc");
    // Expire the challenge via test helper
    cs._expireChallenge("challenge-1");
    cs._sweep();
    assert.equal(cs.getMeta("challenge-1", "userID"), undefined);
    cs.destroy();
  });

  it("consume cleans up associated metadata", () => {
    const cs = createChallengeStore(60000);
    cs.store("challenge-1");
    cs.setMeta("challenge-1", "userID", "user-abc");
    cs.setMeta("challenge-1", "rpID", "localhost");
    assert.ok(cs.consume("challenge-1"));
    // Metadata should be cleaned up after consume
    assert.equal(cs.getMeta("challenge-1", "userID"), undefined);
    assert.equal(cs.getMeta("challenge-1", "rpID"), undefined);
    cs.destroy();
  });
});

describe("getCspHeaders", () => {
  it("returns enforce mode CSP header by default", () => {
    const headers = getCspHeaders();
    assert.ok(headers["Content-Security-Policy"]);
    assert.equal(headers["Content-Security-Policy-Report-Only"], undefined);
  });

  it("returns report-only mode CSP header when requested", () => {
    const headers = getCspHeaders(true);
    assert.ok(headers["Content-Security-Policy-Report-Only"]);
    assert.equal(headers["Content-Security-Policy"], undefined);
  });

  it("includes all required CSP directives", () => {
    const headers = getCspHeaders();
    const policy = headers["Content-Security-Policy"];

    // Check for all required directives
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /style-src 'self' 'unsafe-inline'/);
    assert.match(policy, /connect-src 'self' ws: wss:/);
    assert.match(policy, /img-src 'self' data: blob:/);
    assert.match(policy, /font-src 'self'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /base-uri 'self'/);
    assert.match(policy, /form-action 'self'/);
  });

  it("disallows unsafe-eval in script-src", () => {
    const headers = getCspHeaders();
    const policy = headers["Content-Security-Policy"];
    assert.doesNotMatch(policy, /unsafe-eval/);
  });

  it("allows WebSocket connections", () => {
    const headers = getCspHeaders();
    const policy = headers["Content-Security-Policy"];
    assert.match(policy, /ws:/);
    assert.match(policy, /wss:/);
  });

  it("blocks object sources (Flash, Java, etc.)", () => {
    const headers = getCspHeaders();
    const policy = headers["Content-Security-Policy"];
    assert.match(policy, /object-src 'none'/);
  });

  it("restricts base URI to same origin", () => {
    const headers = getCspHeaders();
    const policy = headers["Content-Security-Policy"];
    assert.match(policy, /base-uri 'self'/);
  });

  it("restricts form actions to same origin", () => {
    const headers = getCspHeaders();
    const policy = headers["Content-Security-Policy"];
    assert.match(policy, /form-action 'self'/);
  });

});

describe("getCsrfToken", () => {
  function makeState(sessionToken, csrfToken) {
    return AuthState.empty("user1")
      .addCredential({ id: "cred1", publicKey: "key", counter: 0 })
      .addLoginToken(sessionToken, Date.now() + 86400000, "cred1", csrfToken);
  }

  it("returns CSRF token for valid session", () => {
    const state = makeState("sess-abc", "csrf-xyz");
    assert.equal(getCsrfToken(state, "sess-abc"), "csrf-xyz");
  });

  it("returns null when session token is not in state", () => {
    const state = makeState("sess-abc", "csrf-xyz");
    assert.equal(getCsrfToken(state, "sess-other"), null);
  });

  it("returns null when state is null", () => {
    assert.equal(getCsrfToken(null, "sess-abc"), null);
  });

  it("returns null when sessionToken is null", () => {
    const state = makeState("sess-abc", "csrf-xyz");
    assert.equal(getCsrfToken(state, null), null);
  });

  it("returns null when session has no csrfToken (backward compat)", () => {
    // addLoginToken with null csrfToken
    const state = AuthState.empty("user1")
      .addCredential({ id: "cred1", publicKey: "key", counter: 0 })
      .addLoginToken("sess-abc", Date.now() + 86400000, "cred1", null);
    assert.equal(getCsrfToken(state, "sess-abc"), null);
  });
});

describe("validateCsrfToken", () => {
  const SESSION_TOKEN = "test-session-token-abcdef1234567890";
  const CSRF_TOKEN = "a".repeat(64); // 64 char CSRF token

  function makeState(csrfToken = CSRF_TOKEN) {
    return AuthState.empty("user1")
      .addCredential({ id: "cred1", publicKey: "key", counter: 0 })
      .addLoginToken(SESSION_TOKEN, Date.now() + 86400000, "cred1", csrfToken);
  }

  function makeReq({ cookie, csrfHeader } = {}) {
    return {
      headers: {
        cookie: cookie ?? `katulong_session=${SESSION_TOKEN}`,
        ...(csrfHeader !== undefined ? { "x-csrf-token": csrfHeader } : {}),
      },
    };
  }

  it("returns true when CSRF token matches", () => {
    const req = makeReq({ csrfHeader: CSRF_TOKEN });
    assert.ok(validateCsrfToken(req, makeState()));
  });

  it("returns false when CSRF token is wrong", () => {
    const req = makeReq({ csrfHeader: "b".repeat(64) });
    assert.ok(!validateCsrfToken(req, makeState()));
  });

  it("returns false when x-csrf-token header is missing", () => {
    const req = makeReq();
    assert.ok(!validateCsrfToken(req, makeState()));
  });

  it("returns false when session cookie is missing", () => {
    const req = { headers: { "x-csrf-token": CSRF_TOKEN } };
    assert.ok(!validateCsrfToken(req, makeState()));
  });

  it("returns false when state is null", () => {
    const req = makeReq({ csrfHeader: CSRF_TOKEN });
    assert.ok(!validateCsrfToken(req, null));
  });

  it("returns false when session not found in state", () => {
    const req = {
      headers: {
        cookie: "katulong_session=unknown-token",
        "x-csrf-token": CSRF_TOKEN,
      },
    };
    assert.ok(!validateCsrfToken(req, makeState()));
  });

  it("returns false when CSRF token length differs (timing-safe check)", () => {
    const req = makeReq({ csrfHeader: "short" });
    assert.ok(!validateCsrfToken(req, makeState()));
  });
});

describe("isAllowedCorsOrigin", () => {
  const PORT = 3001;
  const SERVER_ORIGIN = "https://example.ngrok.app";

  it("allows the server's own tunnel origin", () => {
    assert.ok(isAllowedCorsOrigin(SERVER_ORIGIN, SERVER_ORIGIN, PORT));
  });

  it("allows http://localhost:<PORT>", () => {
    assert.ok(isAllowedCorsOrigin(`http://localhost:${PORT}`, SERVER_ORIGIN, PORT));
  });

  it("allows http://127.0.0.1:<PORT>", () => {
    assert.ok(isAllowedCorsOrigin(`http://127.0.0.1:${PORT}`, SERVER_ORIGIN, PORT));
  });

  it("rejects an arbitrary external origin", () => {
    assert.ok(!isAllowedCorsOrigin("https://evil.com", SERVER_ORIGIN, PORT));
  });

  it("rejects localhost on a different port", () => {
    assert.ok(!isAllowedCorsOrigin("http://localhost:9999", SERVER_ORIGIN, PORT));
  });

  it("rejects a null/undefined origin", () => {
    assert.ok(!isAllowedCorsOrigin(null, SERVER_ORIGIN, PORT));
    assert.ok(!isAllowedCorsOrigin(undefined, SERVER_ORIGIN, PORT));
  });

  it("rejects an empty string origin", () => {
    assert.ok(!isAllowedCorsOrigin("", SERVER_ORIGIN, PORT));
  });

  it("does not allow http://localhost when serverOrigin is http://localhost (no port mismatch)", () => {
    // serverOrigin includes port; bare localhost without port is rejected
    assert.ok(!isAllowedCorsOrigin("http://localhost", "http://localhost:3001", 3001));
  });

  it("allows the server's own localhost origin when running on localhost", () => {
    const localOrigin = "http://localhost:3001";
    assert.ok(isAllowedCorsOrigin(localOrigin, localOrigin, 3001));
  });

  it("rejects a case-variant of an allowed origin (case-sensitive)", () => {
    assert.ok(!isAllowedCorsOrigin("HTTPS://EXAMPLE.NGROK.APP", SERVER_ORIGIN, PORT));
  });

  it("rejects an origin that is a substring of an allowed origin", () => {
    assert.ok(!isAllowedCorsOrigin("https://example.ngrok", SERVER_ORIGIN, PORT));
  });

  it("credentials header should only be set for allowed origins (integration check)", () => {
    const headers = {};
    const setHeader = (k, v) => { headers[k] = v; };
    const origin = "https://evil.com";
    if (isAllowedCorsOrigin(origin, SERVER_ORIGIN, PORT)) {
      setHeader("Access-Control-Allow-Origin", origin);
      setHeader("Access-Control-Allow-Credentials", "true");
    }
    assert.ok(!headers["Access-Control-Allow-Origin"]);
    assert.ok(!headers["Access-Control-Allow-Credentials"]);
  });
});

describe("isHttpsConnection", () => {
  it("returns true when socket is TLS-encrypted", () => {
    const req = { headers: { host: "example.com" }, socket: { encrypted: true } };
    assert.ok(isHttpsConnection(req));
  });

  it("returns false for plain HTTP localhost (dev mode)", () => {
    // Pre-audit, this test used Host=example.com and asserted false. The
    // new heuristic infers https from non-loopback Host, so we now use
    // localhost to keep the spirit of "no tunnel indicators → http".
    const req = { headers: { host: "localhost" }, socket: { encrypted: false } };
    assert.ok(!isHttpsConnection(req));
  });

  it("returns true for .ngrok.app hostname", () => {
    const req = { headers: { host: "abc.ngrok.app" }, socket: {} };
    assert.ok(isHttpsConnection(req));
  });

  it("returns true for .ngrok.io hostname", () => {
    const req = { headers: { host: "abc.ngrok.io" }, socket: {} };
    assert.ok(isHttpsConnection(req));
  });

  it("returns true for .trycloudflare.com hostname", () => {
    const req = { headers: { host: "abc.trycloudflare.com" }, socket: {} };
    assert.ok(isHttpsConnection(req));
  });

  it("returns true for .loca.lt hostname", () => {
    const req = { headers: { host: "abc.loca.lt" }, socket: {} };
    assert.ok(isHttpsConnection(req));
  });

  it("ignores CF-Visitor header — Host alone determines proto", () => {
    // The old code never trusted CF-Visitor for proto. The new code also
    // doesn't. Verify a forged CF-Visitor on a localhost Host stays http.
    const req = {
      headers: { host: "localhost", "cf-visitor": '{"scheme":"https"}' },
      socket: {},
    };
    assert.ok(!isHttpsConnection(req));
  });

  it("returns true for any non-loopback Host (tunnel deployment heuristic)", () => {
    // katulong binds to loopback by design; a non-loopback Host header
    // implies a tunnel terminating TLS in front. CF-Connecting-IP and
    // similar headers used to be checked here but are forgeable by any
    // local process — we now infer HTTPS from Host alone.
    const req = {
      headers: { host: "myapp.example.com" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    assert.ok(isHttpsConnection(req));
  });

  it("returns true for non-loopback Host even from non-loopback socket", () => {
    // Adversarial Host=evil.com case: cookie gets Secure=true, browser
    // refuses to send it on subsequent HTTP, so the attacker's only
    // achievement is breaking their own session. Fail-closed.
    const req = {
      headers: { host: "evil.com" },
      socket: { remoteAddress: "192.168.1.100" },
    };
    assert.ok(isHttpsConnection(req));
  });

  it("does NOT trust CF-Connecting-IP header (any local process can forge it)", () => {
    // Regression for the audit finding: previously, CF-Connecting-IP from
    // a loopback socket was trusted as proof of HTTPS. Any process on the
    // same machine could forge it. The check is gone; only Host being
    // non-loopback matters.
    const req = {
      headers: { host: "localhost", "cf-connecting-ip": "203.0.113.1" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    assert.ok(!isHttpsConnection(req));
  });

  it("returns false with no headers at all", () => {
    const req = { headers: {}, socket: {} };
    assert.ok(!isHttpsConnection(req));
  });

  it("returns false for malformed host header (no suffix match)", () => {
    const req = { headers: { host: ":::invalid:::" }, socket: { remoteAddress: "192.168.1.1" } };
    assert.ok(!isHttpsConnection(req));
  });

  it("returns true for non-loopback Host even from non-loopback socket (Secure fails closed)", () => {
    // Old behavior required a tunnel hostname suffix from the allowlist.
    // New behavior: any non-loopback Host implies a tunnel deployment. If
    // an attacker forges the Host, cookies set with Secure=true won't be
    // re-sent on plain HTTP, so the only effect is the attacker breaks
    // their own session.
    const req = {
      headers: { host: "my.custom-domain.net" },
      socket: { remoteAddress: "203.0.113.5" },
    };
    assert.ok(isHttpsConnection(req));
  });

  it("handles missing socket gracefully", () => {
    const req = { headers: { host: "abc.ngrok.app" }, socket: undefined };
    assert.ok(isHttpsConnection(req));
  });

  it("handles missing socket remoteAddress gracefully", () => {
    // Pre-audit, this test relied on socket.remoteAddress for the
    // CF-Connecting-IP heuristic. That heuristic is gone; the answer
    // now depends only on Host. A non-loopback Host returns true even
    // if the socket has no remoteAddress.
    const req = {
      headers: { host: "myapp.example.com" },
      socket: {},
    };
    assert.ok(isHttpsConnection(req));
  });
});
