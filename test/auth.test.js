import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSession, validateSession, pruneExpiredSessions } from "../lib/auth.js";

describe("createSession", () => {
  it("returns a token that is 64 hex characters", () => {
    const { token } = createSession();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it("returns an expiry roughly 30 days in the future", () => {
    const { expiry } = createSession();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const diff = expiry - Date.now();
    // Allow 5 second tolerance
    assert.ok(diff > thirtyDays - 5000, `expiry too early: ${diff}ms`);
    assert.ok(diff <= thirtyDays, `expiry too late: ${diff}ms`);
  });

  it("generates unique tokens", () => {
    const a = createSession();
    const b = createSession();
    assert.notEqual(a.token, b.token);
  });
});

describe("validateSession", () => {
  it("returns true for a valid session", () => {
    const { token, expiry } = createSession();
    const state = { sessions: { [token]: expiry } };
    assert.ok(validateSession(state, token));
  });

  it("returns false for missing token", () => {
    const state = { sessions: {} };
    assert.ok(!validateSession(state, "nonexistent"));
  });

  it("returns false for expired token", () => {
    const state = { sessions: { expired: Date.now() - 1000 } };
    assert.ok(!validateSession(state, "expired"));
  });

  it("returns false for null state", () => {
    assert.ok(!validateSession(null, "anything"));
  });

  it("returns false for null token", () => {
    const state = { sessions: {} };
    assert.ok(!validateSession(state, null));
  });

  it("returns false when state has no sessions", () => {
    assert.ok(!validateSession({}, "tok"));
  });
});

describe("pruneExpiredSessions", () => {
  it("removes expired sessions", () => {
    const state = {
      sessions: {
        expired1: Date.now() - 10000,
        expired2: Date.now() - 1,
      },
    };
    const result = pruneExpiredSessions(state);
    assert.deepEqual(result.sessions, {});
  });

  it("keeps valid sessions", () => {
    const future = Date.now() + 60000;
    const state = {
      sessions: {
        valid: future,
        expired: Date.now() - 1,
      },
    };
    const result = pruneExpiredSessions(state);
    assert.deepEqual(Object.keys(result.sessions), ["valid"]);
    assert.equal(result.sessions.valid, future);
  });

  it("handles empty sessions object", () => {
    const state = { sessions: {} };
    const result = pruneExpiredSessions(state);
    assert.deepEqual(result.sessions, {});
  });

  it("handles state without sessions key", () => {
    const state = { user: "test" };
    const result = pruneExpiredSessions(state);
    assert.deepEqual(result, { user: "test" });
  });

  it("handles null state", () => {
    const result = pruneExpiredSessions(null);
    assert.equal(result, null);
  });
});
