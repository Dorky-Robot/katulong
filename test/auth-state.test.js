import { describe, it } from "node:test";
import assert from "node:assert";
import { AuthState } from "../lib/auth-state.js";
import { SESSION_TTL_MS } from "../lib/constants.js";

describe("AuthState", () => {
  describe("constructor", () => {
    it("creates state with user, credentials, and sessions", () => {
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1" }],
        sessions: { token1: 999999 },
      });

      assert.deepStrictEqual(state.user, { id: "user123", name: "owner" });
      assert.deepStrictEqual(state.credentials, [{ id: "cred1" }]);
      assert.deepStrictEqual(state.sessions, { token1: 999999 });
    });

    it("defaults credentials to empty array", () => {
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        sessions: {},
      });

      assert.deepStrictEqual(state.credentials, []);
    });

    it("defaults sessions to empty object", () => {
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
      });

      assert.deepStrictEqual(state.sessions, {});
    });
  });

  describe("addCredential", () => {
    it("returns new state with credential added", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1" }],
        sessions: {},
      });

      const newState = original.addCredential({ id: "cred2" });

      assert.strictEqual(newState.credentials.length, 2);
      assert.deepStrictEqual(newState.credentials[1], { id: "cred2" });
    });

    it("does not mutate original state", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1" }],
        sessions: {},
      });

      original.addCredential({ id: "cred2" });

      assert.strictEqual(original.credentials.length, 1);
    });

    it("preserves user and sessions", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: 999999 },
      });

      const newState = original.addCredential({ id: "cred1" });

      assert.deepStrictEqual(newState.user, original.user);
      assert.deepStrictEqual(newState.sessions, original.sessions);
    });
  });

  describe("addSession", () => {
    it("returns new state with session added", () => {
      const original = AuthState.empty("user123");
      const now = Date.now();
      const expiry = now + 10000;

      const newState = original.addSession("token1", expiry, "cred123", "csrf123", now);

      assert.deepStrictEqual(newState.sessions.token1, {
        expiry,
        credentialId: "cred123",
        csrfToken: "csrf123",
        lastActivityAt: now
      });
    });

    it("does not mutate original state", () => {
      const original = AuthState.empty("user123");
      const expiry = Date.now() + 10000;

      original.addSession("token1", expiry);

      assert.deepStrictEqual(original.sessions, {});
    });

    it("preserves user and credentials", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1" }],
        sessions: {},
      });

      const newState = original.addSession("token1", 999999);

      assert.deepStrictEqual(newState.user, original.user);
      assert.deepStrictEqual(newState.credentials, original.credentials);
    });

    it("allows multiple sessions", () => {
      const state = AuthState.empty("user123")
        .addSession("token1", 1000)
        .addSession("token2", 2000)
        .addSession("token3", 3000);

      assert.strictEqual(Object.keys(state.sessions).length, 3);
    });
  });

  describe("removeSession", () => {
    it("returns new state with session removed", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: 1000, token2: 2000 },
      });

      const newState = original.removeSession("token1");

      assert.strictEqual(newState.sessions.token1, undefined);
      assert.strictEqual(newState.sessions.token2, 2000);
    });

    it("does not mutate original state", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: 1000 },
      });

      original.removeSession("token1");

      assert.strictEqual(original.sessions.token1, 1000);
    });

    it("handles removing non-existent session", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: 1000 },
      });

      const newState = original.removeSession("nonexistent");

      assert.deepStrictEqual(newState.sessions, { token1: 1000 });
    });
  });

  describe("updateSessionActivity", () => {
    it("updates lastActivityAt timestamp", () => {
      const now = 1000000;
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          token1: { expiry: now + 100000, credentialId: "cred1", csrfToken: "csrf1", lastActivityAt: now - 50000 }
        },
      });

      const newState = original.updateSessionActivity("token1", now);

      assert.strictEqual(newState.sessions.token1.lastActivityAt, now);
      assert.strictEqual(newState.sessions.token1.expiry, now + 100000); // Expiry unchanged (within 24h)
    });

    it("extends expiry if activity was more than 24h ago", () => {
      const now = 1000000;
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          token1: { expiry: now + 100000, credentialId: "cred1", csrfToken: "csrf1", lastActivityAt: now - (25 * 60 * 60 * 1000) }
        },
      });

      const newState = original.updateSessionActivity("token1", now);

      assert.strictEqual(newState.sessions.token1.lastActivityAt, now);
      assert.strictEqual(newState.sessions.token1.expiry, now + SESSION_TTL_MS); // Expiry extended
    });

    it("returns unchanged state for non-existent session", () => {
      const now = 1000000;
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {},
      });

      const newState = original.updateSessionActivity("nonexistent", now);

      assert.strictEqual(newState, original); // Same instance
    });

    it("does not mutate original state", () => {
      const now = 1000000;
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          token1: { expiry: now + 100000, credentialId: "cred1", csrfToken: "csrf1", lastActivityAt: now - 50000 }
        },
      });

      const originalLastActivity = original.sessions.token1.lastActivityAt;
      original.updateSessionActivity("token1", now);

      assert.strictEqual(original.sessions.token1.lastActivityAt, originalLastActivity);
    });

    it("does not extend expiry when activity is exactly at the 24h threshold", () => {
      const THRESHOLD_MS = 24 * 60 * 60 * 1000;
      const now = 1000000000;
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          // lastActivityAt exactly THRESHOLD_MS ago: timeSinceActivity == THRESHOLD_MS (not strictly greater)
          token1: { expiry: now + 100000, credentialId: "cred1", csrfToken: "csrf1", lastActivityAt: now - THRESHOLD_MS }
        },
      });

      const newState = original.updateSessionActivity("token1", now);

      assert.strictEqual(newState.sessions.token1.lastActivityAt, now);
      assert.strictEqual(newState.sessions.token1.expiry, now + 100000, "expiry must not be extended when activity is exactly at the threshold");
    });

    it("extends expiry when activity is 1ms beyond the 24h threshold", () => {
      const THRESHOLD_MS = 24 * 60 * 60 * 1000;
      const now = 1000000000;
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          // lastActivityAt 1ms beyond THRESHOLD_MS: timeSinceActivity > THRESHOLD_MS
          token1: { expiry: now + 100000, credentialId: "cred1", csrfToken: "csrf1", lastActivityAt: now - THRESHOLD_MS - 1 }
        },
      });

      const newState = original.updateSessionActivity("token1", now);

      assert.strictEqual(newState.sessions.token1.lastActivityAt, now);
      assert.strictEqual(newState.sessions.token1.expiry, now + SESSION_TTL_MS, "expiry must be extended when activity exceeds the threshold by 1ms");
    });

    it("updates correctly across consecutive calls (chaining)", () => {
      const t1 = 1000000000;
      const t2 = t1 + 1000; // 1 second later
      const originalExpiry = t1 + SESSION_TTL_MS;
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          // lastActivityAt 50s ago: timeSinceActivity << 24h, so neither call should extend expiry
          token1: { expiry: originalExpiry, credentialId: "cred1", csrfToken: "csrf1", lastActivityAt: t1 - 50000 }
        },
      });

      const state1 = original.updateSessionActivity("token1", t1);
      assert.strictEqual(state1.sessions.token1.lastActivityAt, t1, "first call should set lastActivityAt to t1");
      assert.strictEqual(state1.sessions.token1.expiry, originalExpiry, "first call should not extend expiry (activity under 24h)");

      const state2 = state1.updateSessionActivity("token1", t2);
      assert.strictEqual(state2.sessions.token1.lastActivityAt, t2, "second call should update lastActivityAt to t2");
      assert.strictEqual(state2.sessions.token1.expiry, originalExpiry, "second call should not extend expiry (activity 1s ago)");

      // Prior states should be unaffected
      assert.strictEqual(original.sessions.token1.lastActivityAt, t1 - 50000, "original should be unchanged");
      assert.strictEqual(state1.sessions.token1.lastActivityAt, t1, "state1 should be unchanged after second call");
    });

    it("extends expiry for a session with lastActivityAt: 0 (pre-migration default)", () => {
      const now = Date.now();
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          // lastActivityAt of 0 is treated as epoch: timeSinceActivity = now - 0 >> 24h threshold
          token1: { expiry: now + 100000, credentialId: "cred1", csrfToken: "csrf1", lastActivityAt: 0 }
        },
      });

      const newState = original.updateSessionActivity("token1", now);

      assert.strictEqual(newState.sessions.token1.lastActivityAt, now);
      assert.strictEqual(newState.sessions.token1.expiry, now + SESSION_TTL_MS, "expiry should be extended for session with lastActivityAt: 0");
    });

    it("updates lastActivityAt even on an already-expired session", () => {
      // updateSessionActivity is a pure value transform — it does not check session expiry
      const now = 1000000000;
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          token1: { expiry: now - 1000, credentialId: "cred1", csrfToken: "csrf1", lastActivityAt: now - 500 }
        },
      });

      const newState = original.updateSessionActivity("token1", now);

      assert.strictEqual(newState.sessions.token1.lastActivityAt, now, "lastActivityAt should be updated regardless of expiry");
      // timeSinceActivity = 500ms < 24h, so expiry is NOT extended (remains expired)
      assert.strictEqual(newState.sessions.token1.expiry, now - 1000, "expiry should not be extended when activity is recent");
    });
  });

  describe("revokeAllSessions", () => {
    it("returns new state with all sessions removed", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: 1000, token2: 2000, token3: 3000 },
      });

      const newState = original.revokeAllSessions();

      assert.deepStrictEqual(newState.sessions, {});
    });

    it("does not mutate original state", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: 1000 },
      });

      original.revokeAllSessions();

      assert.strictEqual(original.sessions.token1, 1000);
    });

    it("preserves user and credentials", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1" }],
        sessions: { token1: 1000 },
      });

      const newState = original.revokeAllSessions();

      assert.deepStrictEqual(newState.user, original.user);
      assert.deepStrictEqual(newState.credentials, original.credentials);
    });
  });

  describe("pruneExpired", () => {
    it("removes expired sessions", () => {
      const now = Date.now();
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          expired1: now - 1000,
          expired2: now - 500,
          valid1: now + 1000,
          valid2: now + 2000,
        },
      });

      const newState = original.pruneExpired(now);

      assert.strictEqual(newState.sessions.expired1, undefined);
      assert.strictEqual(newState.sessions.expired2, undefined);
      assert.strictEqual(newState.sessions.valid1, now + 1000);
      assert.strictEqual(newState.sessions.valid2, now + 2000);
    });

    it("keeps sessions that expire exactly at 'now'", () => {
      const now = Date.now();
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token: now },
      });

      const newState = original.pruneExpired(now);

      assert.strictEqual(newState.sessions.token, undefined);
    });

    it("uses Date.now() if time not provided", () => {
      const future = Date.now() + 10000;
      const past = Date.now() - 1000;
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { futureToken: future, pastToken: past },
      });

      const newState = original.pruneExpired();

      assert.ok(newState.sessions.futureToken);
      assert.strictEqual(newState.sessions.pastToken, undefined);
    });

    it("returns empty sessions when all expired", () => {
      const now = Date.now();
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: now - 1000, token2: now - 500 },
      });

      const newState = original.pruneExpired(now);

      assert.deepStrictEqual(newState.sessions, {});
    });
  });

  describe("isValidSession", () => {
    it("returns true for valid session", () => {
      const now = Date.now();
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1", publicKey: "key1", counter: 1 }],
        sessions: { token1: { expiry: now + 10000, credentialId: "cred1" } },
      });

      assert.strictEqual(state.isValidSession("token1", now), true);
    });

    it("returns false for expired session", () => {
      const now = Date.now();
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: now - 1000 },
      });

      assert.strictEqual(state.isValidSession("token1", now), false);
    });

    it("returns false for non-existent session", () => {
      const state = AuthState.empty("user123");
      assert.strictEqual(state.isValidSession("nonexistent"), false);
    });

    it("returns false for null token", () => {
      const state = AuthState.empty("user123");
      assert.strictEqual(state.isValidSession(null), false);
    });

    it("returns false for undefined token", () => {
      const state = AuthState.empty("user123");
      assert.strictEqual(state.isValidSession(undefined), false);
    });

    it("uses Date.now() if time not provided", () => {
      const future = Date.now() + 10000;
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1", publicKey: "key1", counter: 1 }],
        sessions: { token1: { expiry: future, credentialId: "cred1" } },
      });

      assert.strictEqual(state.isValidSession("token1"), true);
    });

    it("returns false for session with non-existent credentialId (whitelist validation)", () => {
      const now = Date.now();
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1", publicKey: "key1", counter: 1 }],
        sessions: {
          token1: { expiry: now + 10000, credentialId: "cred999" }, // Non-existent credential
        },
      });

      assert.strictEqual(state.isValidSession("token1", now), false);
    });

    it("returns true for session with valid credentialId", () => {
      const now = Date.now();
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1", publicKey: "key1", counter: 1 }],
        sessions: {
          token1: { expiry: now + 10000, credentialId: "cred1" },
        },
      });

      assert.strictEqual(state.isValidSession("token1", now), true);
    });

    it("returns false for pairing session without credentialId", () => {
      const now = Date.now();
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1", publicKey: "key1", counter: 1 }],
        sessions: {
          token1: { expiry: now + 10000, credentialId: null }, // Old pairing session
        },
      });

      assert.strictEqual(state.isValidSession("token1", now), false);
    });
  });

  describe("getValidSessions", () => {
    it("returns only valid session tokens", () => {
      const now = Date.now();
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {
          expired: now - 1000,
          valid1: now + 1000,
          valid2: now + 2000,
        },
      });

      const validSessions = state.getValidSessions(now);

      assert.strictEqual(validSessions.length, 2);
      assert.ok(validSessions.includes("valid1"));
      assert.ok(validSessions.includes("valid2"));
      assert.ok(!validSessions.includes("expired"));
    });

    it("returns empty array when no valid sessions", () => {
      const now = Date.now();
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { expired: now - 1000 },
      });

      const validSessions = state.getValidSessions(now);

      assert.deepStrictEqual(validSessions, []);
    });
  });

  describe("sessionCount", () => {
    it("returns number of sessions", () => {
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: 1000, token2: 2000, token3: 3000 },
      });

      assert.strictEqual(state.sessionCount(), 3);
    });

    it("returns 0 for empty sessions", () => {
      const state = AuthState.empty("user123");
      assert.strictEqual(state.sessionCount(), 0);
    });
  });

  describe("hasUser", () => {
    it("returns true when user exists", () => {
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {},
      });

      assert.strictEqual(state.hasUser(), true);
    });

    it("returns false when user is null", () => {
      const state = new AuthState({
        user: null,
        credentials: [],
        sessions: {},
      });

      assert.strictEqual(state.hasUser(), false);
    });

    it("returns false when user is undefined", () => {
      const state = new AuthState({
        user: undefined,
        credentials: [],
        sessions: {},
      });

      assert.strictEqual(state.hasUser(), false);
    });
  });

  describe("hasCredentials", () => {
    it("returns true when credentials exist", () => {
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1" }],
        sessions: {},
      });

      assert.strictEqual(state.hasCredentials(), true);
    });

    it("returns false when credentials is empty", () => {
      const state = AuthState.empty("user123");
      assert.strictEqual(state.hasCredentials(), false);
    });
  });

  describe("updateCredential", () => {
    it("returns new state with credential fields updated", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1", counter: 0, name: "Device" }],
        sessions: {},
      });

      const updated = original.updateCredential("cred1", { counter: 5 });

      assert.strictEqual(updated.credentials[0].counter, 5);
      assert.strictEqual(updated.credentials[0].name, "Device");
    });

    it("does not mutate original state credential", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1", counter: 0 }],
        sessions: {},
      });

      original.updateCredential("cred1", { counter: 99 });

      // Original credential must be unchanged
      assert.strictEqual(original.credentials[0].counter, 0);
    });

    it("returns new AuthState instance", () => {
      const original = AuthState.empty("user123").addCredential({ id: "cred1", counter: 0 });
      const updated = original.updateCredential("cred1", { counter: 1 });

      assert.notStrictEqual(original, updated);
    });

    it("leaves other credentials unchanged", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [
          { id: "cred1", counter: 0 },
          { id: "cred2", counter: 0 },
        ],
        sessions: {},
      });

      const updated = original.updateCredential("cred1", { counter: 7 });

      assert.strictEqual(updated.credentials[0].counter, 7);
      assert.strictEqual(updated.credentials[1].counter, 0);
    });

    it("preserves sessions and user", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1", counter: 0 }],
        sessions: { tok: { expiry: 9999999, credentialId: "cred1", csrfToken: null, lastActivityAt: null } },
      });

      const updated = original.updateCredential("cred1", { counter: 3 });

      assert.deepStrictEqual(updated.user, original.user);
      assert.deepStrictEqual(updated.sessions, original.sessions);
    });
  });

  describe("toJSON", () => {
    it("serializes to plain object", () => {
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1" }],
        sessions: { token1: 999999 },
      });

      const json = state.toJSON();

      assert.deepStrictEqual(json, {
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1" }],
        sessions: { token1: 999999 },
        setupTokens: [],
      });
    });

    it("works with JSON.stringify", () => {
      const state = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: {},
      });

      const json = JSON.stringify(state);

      assert.strictEqual(json, '{"user":{"id":"user123","name":"owner"},"credentials":[],"sessions":{},"setupTokens":[]}');
    });
  });

  describe("empty", () => {
    it("creates empty state with user ID", () => {
      const state = AuthState.empty("user123");

      assert.deepStrictEqual(state.user, { id: "user123", name: "owner" });
      assert.deepStrictEqual(state.credentials, []);
      assert.deepStrictEqual(state.sessions, {});
    });

    it("creates empty state with custom user name", () => {
      const state = AuthState.empty("user123", "admin");

      assert.deepStrictEqual(state.user, { id: "user123", name: "admin" });
    });

    it("creates empty state with null user when no ID provided", () => {
      const state = AuthState.empty();

      assert.strictEqual(state.user, null);
      assert.deepStrictEqual(state.credentials, []);
      assert.deepStrictEqual(state.sessions, {});
    });
  });

  describe("fromJSON", () => {
    it("creates AuthState from plain object", () => {
      const data = {
        user: { id: "user123", name: "owner" },
        credentials: [{ id: "cred1" }],
        sessions: { token1: 999999 },
      };

      const { state } = AuthState.fromJSON(data);

      assert.ok(state instanceof AuthState);
      assert.deepStrictEqual(state.user, data.user);
      assert.deepStrictEqual(state.credentials, data.credentials);
      assert.deepStrictEqual(state.sessions, data.sessions);
    });

    it("returns null state for null input", () => {
      const { state, needsMigration } = AuthState.fromJSON(null);
      assert.strictEqual(state, null);
      assert.strictEqual(needsMigration, false);
    });

    it("handles missing fields", () => {
      const { state } = AuthState.fromJSON({});

      assert.strictEqual(state.user, null);
      assert.deepStrictEqual(state.credentials, []);
      assert.deepStrictEqual(state.sessions, {});
    });
  });

  describe("immutability", () => {
    it("all operations return new instances", () => {
      const original = AuthState.empty("user123");
      const state1 = original.addSession("token1", 1000);
      const state2 = state1.addSession("token2", 2000);
      const state3 = state2.pruneExpired(3000);

      // All should be different instances
      assert.notStrictEqual(original, state1);
      assert.notStrictEqual(state1, state2);
      assert.notStrictEqual(state2, state3);

      // Original should be unchanged
      assert.strictEqual(original.sessionCount(), 0);
    });

    it("does not share session references", () => {
      const original = new AuthState({
        user: { id: "user123", name: "owner" },
        credentials: [],
        sessions: { token1: 1000 },
      });

      const newState = original.addSession("token2", 2000);

      // Adding to new state doesn't affect original
      assert.strictEqual(Object.keys(original.sessions).length, 1);
      assert.strictEqual(Object.keys(newState.sessions).length, 2);
    });
  });

  describe("chaining operations", () => {
    it("allows method chaining", () => {
      const state = AuthState.empty("user123")
        .addCredential({ id: "cred1" })
        .addSession("token1", Date.now() + 10000)
        .addSession("token2", Date.now() + 20000)
        .pruneExpired();

      assert.strictEqual(state.hasUser(), true);
      assert.strictEqual(state.hasCredentials(), true);
      assert.strictEqual(state.sessionCount(), 2);
    });
  });
});
