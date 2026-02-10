import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import {
  parseCookies,
  setSessionCookie,
  getOriginAndRpID,
  isPublicPath,
  sanitizeName,
  createChallengeStore,
  escapeAttr,
  getCspHeaders,
} from "../lib/http-util.js";

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

describe("sanitizeName", () => {
  it("returns null for null/undefined", () => {
    assert.equal(sanitizeName(null), null);
    assert.equal(sanitizeName(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.equal(sanitizeName(""), null);
  });

  it("returns null for non-string", () => {
    assert.equal(sanitizeName(42), null);
  });

  it("passes through safe names", () => {
    assert.equal(sanitizeName("my-session_1"), "my-session_1");
  });

  it("strips unsafe characters", () => {
    assert.equal(sanitizeName("hello world!@#$"), "helloworld");
  });

  it("returns null if all characters are unsafe", () => {
    assert.equal(sanitizeName("!@#$%^&*()"), null);
  });

  it("truncates to 64 characters", () => {
    const long = "a".repeat(100);
    const result = sanitizeName(long);
    assert.equal(result.length, 64);
    assert.equal(result, "a".repeat(64));
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

  it("allows /pair", () => {
    assert.ok(isPublicPath("/pair"));
  });

  it("allows /auth/pair/verify", () => {
    assert.ok(isPublicPath("/auth/pair/verify"));
  });

  it("rejects /auth/pair/start (protected)", () => {
    assert.ok(!isPublicPath("/auth/pair/start"));
  });

  it("rejects unknown /auth/ paths", () => {
    assert.ok(!isPublicPath("/auth/admin"));
    assert.ok(!isPublicPath("/auth/secret"));
    assert.ok(!isPublicPath("/auth/"));
  });

  it("allows /connect/trust paths", () => {
    assert.ok(isPublicPath("/connect/trust"));
    assert.ok(isPublicPath("/connect/trust/ca.crt"));
    assert.ok(isPublicPath("/connect/trust/ca.mobileconfig"));
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
  it("extracts host and defaults to http", () => {
    const req = { headers: { host: "example.com:3001" } };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "http://example.com:3001");
    assert.equal(rpID, "example.com");
  });

  it("uses https when socket is encrypted", () => {
    const req = { headers: { host: "example.com" }, socket: { encrypted: true } };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "https://example.com");
    assert.equal(rpID, "example.com");
  });

  it("ignores x-forwarded-proto when socket is not encrypted (no header trust)", () => {
    const req = { headers: { host: "example.com", "x-forwarded-proto": "https" } };
    const { origin, rpID } = getOriginAndRpID(req);
    assert.equal(origin, "http://example.com"); // Should be http, not https
    assert.equal(rpID, "example.com");
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
    assert.ok(cookies[0].includes("SameSite=Strict"));
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
    const { store, consume } = createChallengeStore(60000);
    store("challenge-1");
    assert.ok(consume("challenge-1"));
  });

  it("returns false for unknown challenge", () => {
    const { consume } = createChallengeStore(60000);
    assert.ok(!consume("nonexistent"));
  });

  it("challenge is single-use", () => {
    const { store, consume } = createChallengeStore(60000);
    store("once");
    assert.ok(consume("once"));
    assert.ok(!consume("once"));
  });

  it("expired challenges are rejected", () => {
    const { store, consume, _challenges } = createChallengeStore(1000);
    store("exp");
    // Manually set expiry to the past
    _challenges.set("exp", Date.now() - 1);
    assert.ok(!consume("exp"));
  });

  it("prunes expired entries during consume", () => {
    const { store, consume, _challenges } = createChallengeStore(1000);
    store("old");
    store("current");
    // Expire "old"
    _challenges.set("old", Date.now() - 1);
    // Consuming "current" should prune "old"
    consume("current");
    assert.ok(!_challenges.has("old"));
  });

  it("periodic sweep cleans up expired challenges", () => {
    const { store, _challenges, _sweep } = createChallengeStore(100);

    // Store some challenges
    store("challenge-1");
    store("challenge-2");
    store("challenge-3");

    // All challenges should exist initially
    assert.equal(_challenges.size, 3);

    // Manually expire all challenges
    for (const [key] of _challenges) {
      _challenges.set(key, Date.now() - 1);
    }

    // Trigger sweep manually
    _sweep();

    // After sweep, expired challenges should be removed
    assert.equal(_challenges.size, 0, "Expired challenges should be removed by sweep");
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
    assert.match(policy, /img-src 'self' data:/);
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
