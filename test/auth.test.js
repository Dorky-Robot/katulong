import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSession, validateSession, pruneExpiredSessions, loadState, saveState, _invalidateCache, refreshSessionActivity, withStateLock } from "../lib/auth.js";
import { AuthState } from "../lib/auth-state.js";
import { SESSION_TTL_MS } from "../lib/env-config.js";
import envConfig from "../lib/env-config.js";
import { writeAuthFixture } from "./helpers/auth-fixture.js";

const DATA_DIR = envConfig.dataDir;
const USER_PATH = join(DATA_DIR, "user.json");

// Remove all per-entity auth files from the data dir
function clearAuthFiles() {
  try { unlinkSync(USER_PATH); } catch {}
  for (const sub of ["credentials", "sessions", "setup-tokens"]) {
    try { rmSync(join(DATA_DIR, sub), { recursive: true, force: true }); } catch {}
  }
}

describe("createSession", () => {
  it("returns a token that is 64 hex characters", () => {
    const { token } = createSession();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it("returns an expiry roughly 30 days in the future", () => {
    const { expiry } = createSession();
    const diff = expiry - Date.now();
    // Allow 5 second tolerance
    assert.ok(diff > SESSION_TTL_MS - 5000, `expiry too early: ${diff}ms`);
    assert.ok(diff <= SESSION_TTL_MS, `expiry too late: ${diff}ms`);
  });

  it("generates unique tokens", () => {
    const a = createSession();
    const b = createSession();
    assert.notEqual(a.token, b.token);
  });
});

describe("validateSession", () => {
  const credential = { id: "cred1", publicKey: "key1", counter: 0 };

  function makeState(sessions = {}) {
    return new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions,
      setupTokens: [],
    });
  }

  it("returns true for a valid session", () => {
    const { token, expiry, csrfToken, lastActivityAt } = createSession();
    const state = makeState({
      [token]: { expiry, credentialId: credential.id, csrfToken, lastActivityAt },
    });
    assert.ok(validateSession(state, token));
  });

  it("returns false for missing token", () => {
    const state = makeState();
    assert.ok(!validateSession(state, "nonexistent"));
  });

  it("returns false for expired token", () => {
    const state = makeState({
      expired: { expiry: Date.now() - 1000, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: Date.now() - 2000 },
    });
    assert.ok(!validateSession(state, "expired"));
  });

  it("returns false for null state", () => {
    assert.ok(!validateSession(null, "anything"));
  });

  it("returns false for null token", () => {
    const state = makeState();
    assert.ok(!validateSession(state, null));
  });

  it("returns false when state has no sessions", () => {
    assert.ok(!validateSession(AuthState.empty(), "tok"));
  });

  it("returns false when session credentialId does not match any credential", () => {
    const state = makeState({
      tok: { expiry: Date.now() + 60000, credentialId: "nonexistent-cred", csrfToken: "csrf", lastActivityAt: Date.now() },
    });
    assert.ok(!validateSession(state, "tok"), "session with orphaned credentialId should be invalid");
  });

  it("returns false when session credentialId is null", () => {
    const state = makeState({
      tok: { expiry: Date.now() + 60000, credentialId: null, csrfToken: "csrf", lastActivityAt: Date.now() },
    });
    assert.ok(!validateSession(state, "tok"), "session without credentialId should be invalid");
  });

  it("returns false for old-format session (plain number expiry in AuthState)", () => {
    // AuthState can hold a number-format session if constructed directly;
    // isValidSession must reject it regardless
    const state = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: { tok: Date.now() + 60000 },
      setupTokens: [],
    });
    assert.ok(!validateSession(state, "tok"), "old number-format session in AuthState should be rejected");
  });

  it("returns false for session object missing credentialId property entirely", () => {
    // { credentialId: null } has the property present (fails check 6);
    // an object without the property at all must fail check 4 ('credentialId' in session)
    const state = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: { tok: { expiry: Date.now() + 60000, csrfToken: "csrf" } },
      setupTokens: [],
    });
    assert.ok(!validateSession(state, "tok"), "session object without credentialId property should be rejected");
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

describe("loadState caching", () => {
  let backupState;

  beforeEach(() => {
    // Back up existing state
    _invalidateCache();
    backupState = loadState();
    _invalidateCache();
  });

  afterEach(() => {
    // Restore original state
    _invalidateCache();
    if (backupState) {
      saveState(backupState);
    } else {
      clearAuthFiles();
    }
    _invalidateCache();
  });

  it("returns cached value on second call without re-reading disk", () => {
    const state = { user: null, credentials: [], sessions: {}, setupTokens: [] };
    saveState(state);

    const first = loadState();
    // Overwrite user.json directly — loadState should still return the cached value
    writeFileSync(USER_PATH, JSON.stringify({ id: "changed", name: "owner" }));
    const second = loadState();

    assert.deepEqual(first.toJSON(), state);
    assert.deepEqual(second.toJSON(), state, "second call should return cached value, not re-read disk");
  });

  it("saveState updates the cache immediately", () => {
    const stateA = { user: { id: "a", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };
    const stateB = { user: { id: "b", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };

    saveState(stateA);
    assert.deepEqual(loadState().toJSON(), stateA);

    saveState(stateB);
    assert.deepEqual(loadState().toJSON(), stateB, "cache should reflect the latest saveState call");
  });

  it("_invalidateCache forces a re-read from disk", () => {
    const original = { user: { id: "1", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };
    saveState(original);
    assert.deepEqual(loadState().toJSON(), original);

    // Write different user.json directly to disk
    const updated = { user: { id: "2", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };
    writeAuthFixture(DATA_DIR, updated);

    // Cache still holds old value
    assert.deepEqual(loadState().toJSON(), original);

    // After invalidation, it re-reads from disk
    _invalidateCache();
    assert.deepEqual(loadState().toJSON(), updated, "should re-read from disk after cache invalidation");
  });

  it("loadState returns null and caches it when user.json does not exist", () => {
    clearAuthFiles();
    _invalidateCache();

    assert.equal(loadState(), null);
    // Write state files — but cache should still return null
    writeAuthFixture(DATA_DIR, { user: { id: "test", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] });
    assert.equal(loadState(), null, "null should be cached too");

    _invalidateCache();
    const loaded = loadState();
    assert.ok(loaded, "should load state after invalidation");
    assert.deepEqual(loaded.toJSON(), { user: { id: "test", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] }, "after invalidation should read new files");
  });

  it("loadState migrates and cleans up orphaned sessions", () => {
    const now = Date.now();
    const state = {
      user: { id: "user123", name: "owner" },
      credentials: [
        { id: "cred1", publicKey: "key1", counter: 1, deviceId: "dev1", name: "Device 1" },
        { id: "cred2", publicKey: "key2", counter: 1, deviceId: "dev2", name: "Device 2" }
      ],
      sessions: {
        // Valid session for existing credential
        "token1": { expiry: now + 10000, credentialId: "cred1" },
        // Orphaned session for removed credential
        "token2": { expiry: now + 10000, credentialId: "cred999" },
        // Old pairing session (credentialId: null - should be removed, pairing now creates credentials)
        "token5": { expiry: now + 10000, credentialId: null }
      }
    };

    writeAuthFixture(DATA_DIR, state);
    _invalidateCache();

    const loaded = loadState();
    const sessions = loaded.sessions;

    // Should keep token1 (valid credential)
    assert.ok(sessions.token1, "should keep session for existing credential");
    assert.equal(sessions.token1.credentialId, "cred1");

    // Should remove token2 (orphaned - credential doesn't exist)
    assert.equal(sessions.token2, undefined, "should remove session for non-existent credential");

    // Should remove token5 (old pairing session - pairing now creates credentials)
    assert.equal(sessions.token5, undefined, "should remove old pairing sessions");
  });

  it("loadState prunes expired setup tokens and persists the change", () => {
    const now = Date.now();
    const state = {
      user: { id: "user123", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 1, deviceId: "dev1", name: "Device 1" }],
      sessions: {},
      setupTokens: [
        // Valid token (not expired)
        { id: "tok1", token: "validtoken", name: "Valid", createdAt: now - 1000, lastUsedAt: null, expiresAt: now + 7 * 24 * 60 * 60 * 1000 },
        // Expired token
        { id: "tok2", token: "expiredtoken", name: "Expired", createdAt: now - 20000, lastUsedAt: null, expiresAt: now - 1 },
        // Legacy token without expiresAt (fail-closed: treated as expired)
        { id: "tok3", token: "legacytoken", name: "Legacy", createdAt: now - 30000, lastUsedAt: null },
      ],
    };

    clearAuthFiles();
    writeAuthFixture(DATA_DIR, state);
    _invalidateCache();

    const loaded = loadState();
    const tokens = loaded.setupTokens;

    assert.equal(tokens.length, 1, "should only keep valid non-expired token");
    assert.equal(tokens[0].id, "tok1", "should keep the valid token");
    assert.equal(tokens.find(t => t.id === "tok2"), undefined, "should remove expired token");
    assert.equal(tokens.find(t => t.id === "tok3"), undefined, "should remove legacy token without expiresAt");
  });
});

describe("loadState - credential metadata migration", () => {
  let backupState;

  beforeEach(() => {
    _invalidateCache();
    backupState = loadState();
    _invalidateCache();
  });

  afterEach(() => {
    _invalidateCache();
    if (backupState) {
      saveState(backupState);
    } else {
      clearAuthFiles();
    }
    _invalidateCache();
  });

  it("adds deviceId, name, createdAt, lastUsedAt, userAgent to credentials missing metadata", () => {
    const now = Date.now();
    const state = {
      user: { id: "user1", name: "owner" },
      credentials: [
        // Old credential without any metadata fields
        { id: "cred1", publicKey: "key1", counter: 0 },
        // Old credential with some but not all metadata (missing name → triggers migration)
        { id: "cred2", publicKey: "key2", counter: 0, deviceId: "dev2" },
      ],
      sessions: {},
      setupTokens: [],
    };

    writeAuthFixture(DATA_DIR, state);
    _invalidateCache();

    const loaded = loadState();
    const creds = loaded.credentials;

    // First credential should get all metadata
    assert.equal(creds[0].id, "cred1");
    assert.equal(creds[0].deviceId, null, "old credential gets null deviceId");
    assert.equal(creds[0].name, "Device 1", "old credential gets index-based name");
    assert.ok(creds[0].createdAt >= now, "createdAt should be set to current time");
    assert.ok(creds[0].lastUsedAt >= now, "lastUsedAt should be set to current time");
    assert.equal(creds[0].userAgent, "Unknown", "userAgent defaults to Unknown");

    // Second credential (missing name) should get defaults too
    assert.equal(creds[1].deviceId, "dev2", "existing deviceId is preserved");
    assert.equal(creds[1].name, "Device 2", "missing name gets index-based default");
  });

  it("does not modify credentials that already have deviceId and name", () => {
    const now = Date.now() - 5000;
    const state = {
      user: { id: "user1", name: "owner" },
      credentials: [
        {
          id: "cred1", publicKey: "key1", counter: 0,
          deviceId: "existing-dev", name: "My MacBook",
          createdAt: now, lastUsedAt: now, userAgent: "Safari",
        },
      ],
      sessions: {},
      setupTokens: [],
    };

    writeAuthFixture(DATA_DIR, state);
    _invalidateCache();

    const loaded = loadState();
    const cred = loaded.credentials[0];

    assert.equal(cred.deviceId, "existing-dev", "deviceId must not change");
    assert.equal(cred.name, "My MacBook", "name must not change");
    assert.equal(cred.createdAt, now, "createdAt must not change");
    assert.equal(cred.lastUsedAt, now, "lastUsedAt must not change");
    assert.equal(cred.userAgent, "Safari", "userAgent must not change");
  });

  it("saves migrated credential metadata to disk", () => {
    const state = {
      user: { id: "user1", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0 }],
      sessions: {},
      setupTokens: [],
    };

    writeAuthFixture(DATA_DIR, state);
    _invalidateCache();
    loadState();

    // Re-read from disk to confirm migration was persisted
    _invalidateCache();
    const reloaded = loadState();
    assert.equal(reloaded.credentials[0].name, "Device 1", "migration should be persisted to disk");
    assert.ok(reloaded.credentials[0].createdAt, "createdAt should be persisted");
  });
});

describe("loadState - session lastActivityAt migration", () => {
  let backupState;

  beforeEach(() => {
    _invalidateCache();
    backupState = loadState();
    _invalidateCache();
  });

  afterEach(() => {
    _invalidateCache();
    if (backupState) {
      saveState(backupState);
    } else {
      clearAuthFiles();
    }
    _invalidateCache();
  });

  it("adds lastActivityAt to sessions that are missing it", () => {
    const now = Date.now();
    const state = {
      user: { id: "user1", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0, deviceId: "d1", name: "Device 1" }],
      sessions: {
        "tok1": { expiry: now + 10000, credentialId: "cred1" }, // missing lastActivityAt
      },
      setupTokens: [],
    };

    writeAuthFixture(DATA_DIR, state);
    _invalidateCache();

    const loaded = loadState();
    const session = loaded.sessions["tok1"];

    assert.ok(session, "session should still exist");
    assert.ok(session.lastActivityAt >= now, "lastActivityAt should be set to current time");
    assert.equal(session.credentialId, "cred1", "credentialId must be preserved");
    assert.equal(session.expiry, now + 10000, "expiry must be preserved");
  });

  it("does not modify sessions that already have lastActivityAt", () => {
    const past = Date.now() - 10000;
    const now = Date.now();
    const state = {
      user: { id: "user1", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0, deviceId: "d1", name: "Device 1" }],
      sessions: {
        "tok1": { expiry: now + 10000, credentialId: "cred1", lastActivityAt: past },
      },
      setupTokens: [],
    };

    writeAuthFixture(DATA_DIR, state);
    _invalidateCache();

    const loaded = loadState();
    const session = loaded.sessions["tok1"];

    assert.equal(session.lastActivityAt, past, "existing lastActivityAt must not be changed");
  });

  it("saves migrated lastActivityAt to disk", () => {
    const now = Date.now();
    const state = {
      user: { id: "user1", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0, deviceId: "d1", name: "Device 1" }],
      sessions: {
        "tok1": { expiry: now + 10000, credentialId: "cred1" },
      },
      setupTokens: [],
    };

    writeAuthFixture(DATA_DIR, state);
    _invalidateCache();
    loadState();

    // Re-read from disk
    _invalidateCache();
    const reloaded = loadState();
    assert.ok(reloaded.sessions["tok1"].lastActivityAt >= now, "lastActivityAt should be persisted to disk");
  });

  it("applies credential and session migrations together on a very old state file", () => {
    const now = Date.now();
    const state = {
      user: { id: "user1", name: "owner" },
      // Old credentials without metadata
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0 }],
      sessions: {
        // Old session without lastActivityAt (and also needs credential cleanup check)
        "tok1": { expiry: now + 10000, credentialId: "cred1" },
      },
      setupTokens: [],
    };

    writeAuthFixture(DATA_DIR, state);
    _invalidateCache();

    const loaded = loadState();

    // Credential migration applied
    assert.equal(loaded.credentials[0].name, "Device 1", "credential metadata migration applied");
    assert.equal(loaded.credentials[0].deviceId, null, "deviceId set to null for old credential");

    // Session activity migration applied
    assert.ok(loaded.sessions["tok1"], "valid session preserved");
    assert.ok(loaded.sessions["tok1"].lastActivityAt >= now, "lastActivityAt added to valid session");
  });
});

describe("loadState - corrupted state file handling", () => {
  let backupState;

  beforeEach(() => {
    _invalidateCache();
    backupState = loadState();
    _invalidateCache();
  });

  afterEach(() => {
    _invalidateCache();
    if (backupState) {
      saveState(backupState);
    } else {
      clearAuthFiles();
    }
    _invalidateCache();
  });

  it("returns null for corrupt user.json (unparsable content)", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(USER_PATH, "{ invalid json ::::");
    _invalidateCache();
    const result = loadState();
    assert.equal(result, null, "corrupt JSON should return null rather than throw");
  });

  it("returns null for truncated user.json", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(USER_PATH, '{"id": "test"'); // truncated before closing brace
    _invalidateCache();
    const result = loadState();
    assert.equal(result, null, "truncated JSON should return null");
  });

  it("returns null for empty user.json", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(USER_PATH, "");
    _invalidateCache();
    const result = loadState();
    assert.equal(result, null, "empty file should return null");
  });

  it("returns null for user.json containing only whitespace", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(USER_PATH, "   \n  \t  ");
    _invalidateCache();
    const result = loadState();
    assert.equal(result, null, "whitespace-only file should return null");
  });

  it("can recover and load valid state after corruption is fixed", () => {
    // Write corrupt file first
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(USER_PATH, "not-json");
    _invalidateCache();
    assert.equal(loadState(), null, "should be null when corrupt");

    // Now fix the files
    const validState = { user: { id: "recover", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };
    writeAuthFixture(DATA_DIR, validState);
    _invalidateCache();
    const result = loadState();
    assert.ok(result, "should load successfully after fixing corruption");
    assert.equal(result.user.id, "recover");
  });
});

describe("validateSession - boundary and edge cases", () => {
  const credential = { id: "cred1", publicKey: "key1", counter: 0 };

  function makeState(sessions = {}) {
    return new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions,
      setupTokens: [],
    });
  }

  it("returns false for session expiring exactly 1ms in the past", () => {
    const state = makeState({
      tok: { expiry: Date.now() - 1, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: Date.now() - 2 },
    });
    assert.ok(!validateSession(state, "tok"), "session expired 1ms ago should be invalid");
  });

  it("returns true for session expiring 1ms in the future", () => {
    const state = makeState({
      tok: { expiry: Date.now() + 1000, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: Date.now() },
    });
    assert.ok(validateSession(state, "tok"), "session expiring 1s from now should be valid");
  });

  it("returns false for session with expiry of 0 (epoch)", () => {
    const state = makeState({
      tok: { expiry: 0, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: 0 },
    });
    assert.ok(!validateSession(state, "tok"), "expiry of 0 (epoch) is always in the past");
  });

  it("returns false for empty-string token", () => {
    const state = makeState({
      "": { expiry: Date.now() + 60000, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: Date.now() },
    });
    assert.ok(!validateSession(state, ""), "empty token should not be valid");
  });
});

describe("pruneExpiredSessions - boundary conditions", () => {
  it("removes sessions with expiry exactly equal to Date.now() - 1", () => {
    const expiry = Date.now() - 1;
    const state = { sessions: { boundaryToken: expiry } };
    const result = pruneExpiredSessions(state);
    assert.equal(result.sessions.boundaryToken, undefined, "just-expired session should be pruned");
  });

  it("keeps sessions with expiry well in the future", () => {
    const expiry = Date.now() + 1000 * 60 * 60; // 1 hour from now
    const state = { sessions: { futureToken: expiry } };
    const result = pruneExpiredSessions(state);
    assert.ok(result.sessions.futureToken, "future session should be kept");
  });

  it("handles mixed valid and expired sessions in one pass", () => {
    const now = Date.now();
    const state = {
      sessions: {
        valid1: now + 10000,
        expired1: now - 10000,
        valid2: now + 20000,
        expired2: now - 1,
      },
    };
    const result = pruneExpiredSessions(state);
    assert.ok(result.sessions.valid1, "valid1 should survive");
    assert.ok(result.sessions.valid2, "valid2 should survive");
    assert.equal(result.sessions.expired1, undefined, "expired1 should be pruned");
    assert.equal(result.sessions.expired2, undefined, "expired2 should be pruned");
    assert.equal(Object.keys(result.sessions).length, 2);
  });
});

describe("refreshSessionActivity", () => {
  let backupState;

  beforeEach(() => {
    _invalidateCache();
    backupState = loadState();
    _invalidateCache();
  });

  afterEach(() => {
    _invalidateCache();
    if (backupState) {
      saveState(backupState);
    } else {
      clearAuthFiles();
    }
    _invalidateCache();
  });

  const credential = { id: "cred1", publicKey: "key1", counter: 0, deviceId: "dev1", name: "Test Device" };

  function makeValidState(token, sessionOverrides = {}) {
    const now = Date.now();
    return new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: {
        [token]: {
          expiry: now + SESSION_TTL_MS,
          credentialId: credential.id,
          csrfToken: "csrf1",
          lastActivityAt: now - 2 * 60 * 60 * 1000, // 2 hours ago
          ...sessionOverrides,
        },
      },
      setupTokens: [],
    });
  }

  it("returns early for null token without calling withStateLock", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    await refreshSessionActivity(null);

    const loaded = loadState();
    assert.deepEqual(Object.keys(loaded.sessions), [], "no sessions should be added for null token");
  });

  it("returns early for undefined token without throwing", async () => {
    await assert.doesNotReject(
      () => refreshSessionActivity(undefined),
      "refreshSessionActivity should not throw for undefined token"
    );
  });

  it("updates lastActivityAt for a valid session", async () => {
    const token = "validtoken123";
    const initial = makeValidState(token);
    const originalLastActivity = initial.sessions[token].lastActivityAt;
    const beforeCall = Date.now() - 1;
    saveState(initial);

    await refreshSessionActivity(token);

    const updated = loadState();
    assert.ok(updated.sessions[token], "session should still exist after refresh");
    assert.ok(
      updated.sessions[token].lastActivityAt > originalLastActivity,
      "lastActivityAt should be updated to a more recent time"
    );
    assert.ok(
      updated.sessions[token].lastActivityAt >= beforeCall,
      "lastActivityAt should be at or after the time of the call"
    );
  });

  it("does not update lastActivityAt for an expired token", async () => {
    const token = "expiredtoken456";
    const now = Date.now();
    const initial = makeValidState(token, {
      expiry: now - 1000, // expired 1 second ago
      lastActivityAt: now - 2000,
    });
    const originalLastActivity = initial.sessions[token].lastActivityAt;
    saveState(initial);

    await refreshSessionActivity(token);

    const loaded = loadState();
    assert.equal(
      loaded.sessions[token].lastActivityAt,
      originalLastActivity,
      "expired session lastActivityAt should not be updated"
    );
  });

  it("does not modify state for a non-existent token", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    await refreshSessionActivity("doesnotexist");

    const loaded = loadState();
    assert.deepEqual(Object.keys(loaded.sessions), [], "no sessions should be created for unknown token");
  });

  it("is a no-op when there is no auth state (null state)", async () => {
    clearAuthFiles();
    _invalidateCache();

    await assert.doesNotReject(
      () => refreshSessionActivity("sometoken"),
      "refreshSessionActivity should not throw when no state files exist"
    );
  });

  it("extends session expiry when lastActivityAt is more than 24h ago (sliding window)", async () => {
    const token = "oldactivitytoken";
    const now = Date.now();
    // Use a short initial expiry (10 minutes) so any sliding-window extension to 30 days is unambiguous
    const initial = makeValidState(token, {
      expiry: now + 10 * 60 * 1000, // 10 minutes from now
      lastActivityAt: now - 25 * 60 * 60 * 1000, // 25 hours ago, beyond the 24h threshold
    });
    const originalExpiry = initial.sessions[token].expiry;
    saveState(initial);

    await refreshSessionActivity(token);

    const updated = loadState();
    assert.ok(
      updated.sessions[token].expiry > originalExpiry,
      "expiry should be extended when lastActivityAt was more than 24h ago"
    );
    assert.ok(
      updated.sessions[token].expiry >= now + SESSION_TTL_MS - 1000,
      "expiry should be approximately 30 days from now"
    );
  });
});

describe("withStateLock", () => {
  let backupState;

  beforeEach(() => {
    _invalidateCache();
    backupState = loadState();
    _invalidateCache();
  });

  afterEach(() => {
    _invalidateCache();
    if (backupState) {
      saveState(backupState);
    } else {
      clearAuthFiles();
    }
    _invalidateCache();
  });

  it("saves state when modifier returns a state key", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0, deviceId: "d1", name: "Device 1" }],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    await withStateLock(async (state) => {
      const { token, expiry, csrfToken, lastActivityAt } = createSession();
      const newState = new AuthState({
        user: state.user,
        credentials: state.credentials,
        sessions: { ...state.sessions, [token]: { expiry, credentialId: "cred1", csrfToken, lastActivityAt } },
        setupTokens: state.setupTokens,
      });
      return { state: newState };
    });

    _invalidateCache();
    const loaded = loadState();
    assert.ok(Object.keys(loaded.sessions).length > 0, "session should be persisted");
  });

  it("does not save when modifier returns without a state key (read-only)", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0, deviceId: "d1", name: "Device 1" }],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    const result = await withStateLock(async (state) => {
      return { hasCredentials: state.credentials.length > 0 };
    });

    assert.strictEqual(result.hasCredentials, true, "modifier return value should be passed through");

    _invalidateCache();
    const loaded = loadState();
    assert.deepEqual(Object.keys(loaded.sessions), [], "no sessions should be created for read-only operation");
  });

  it("serializes concurrent operations (mutex behavior)", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0, deviceId: "d1", name: "Device 1" }],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    const order = [];

    const op1 = withStateLock(async () => {
      order.push("op1-start");
      await new Promise(resolve => setTimeout(resolve, 50));
      order.push("op1-end");
      return {};
    });

    const op2 = withStateLock(async () => {
      order.push("op2-start");
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push("op2-end");
      return {};
    });

    await Promise.all([op1, op2]);

    assert.deepEqual(order, ["op1-start", "op1-end", "op2-start", "op2-end"],
      "operations should be serialized, not interleaved");
  });

  it("continues after error in modifier (mutex chain not broken)", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    // First operation throws
    await assert.rejects(
      () => withStateLock(async () => { throw new Error("modifier error"); }),
      /modifier error/
    );

    // Second operation should still work
    let ran = false;
    await withStateLock(async () => {
      ran = true;
      return {};
    });
    assert.ok(ran, "mutex should recover after error in previous operation");
  });

  it("returns the full result object from the modifier", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0, deviceId: "d1", name: "Device 1" }],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    const result = await withStateLock(async (state) => {
      return { found: true, count: state.credentials.length };
    });

    assert.strictEqual(result.found, true);
    assert.strictEqual(result.count, 1);
  });

  it("invalidates cache before each operation to prevent stale reads", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0, deviceId: "d1", name: "Device 1" }],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    // Direct disk write outside of cache
    writeAuthFixture(DATA_DIR, {
      user: { id: "user-changed", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 0, deviceId: "d1", name: "Device 1" }],
      sessions: {},
      setupTokens: [],
    });

    const result = await withStateLock(async (state) => {
      return { userId: state.user.id };
    });

    assert.strictEqual(result.userId, "user-changed",
      "withStateLock should invalidate cache and read fresh state from disk");
  });
});
