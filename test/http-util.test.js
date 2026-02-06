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

  it("allows /auth/* paths", () => {
    assert.ok(isPublicPath("/auth/status"));
    assert.ok(isPublicPath("/auth/login/options"));
    assert.ok(isPublicPath("/auth/register/verify"));
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

  it("respects x-forwarded-proto", () => {
    const req = { headers: { host: "example.com", "x-forwarded-proto": "https" } };
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
