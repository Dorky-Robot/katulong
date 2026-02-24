import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { AuthState } from "../lib/auth-state.js";

describe("Setup Tokens", () => {
  let state;

  beforeEach(() => {
    state = AuthState.empty();
  });

  describe("addSetupToken", () => {
    it("adds a setup token to empty state and stores hash/salt (not plaintext)", () => {
      const tokenData = {
        id: "token123",
        token: "abc123def456",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const newState = state.addSetupToken(tokenData);

      assert.strictEqual(newState.setupTokens.length, 1);
      const stored = newState.setupTokens[0];
      // Token should be hashed — no plaintext token field
      assert.strictEqual(stored.token, undefined, "plaintext token must not be stored");
      assert.ok(typeof stored.hash === "string" && stored.hash.length > 0, "hash should be stored");
      assert.ok(typeof stored.salt === "string" && stored.salt.length > 0, "salt should be stored");
      assert.strictEqual(stored.id, "token123");
      assert.strictEqual(stored.name, "Test Token");
    });

    it("adds multiple setup tokens", () => {
      const token1 = {
        id: "token1",
        token: "abc123",
        name: "Token 1",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const token2 = {
        id: "token2",
        token: "def456",
        name: "Token 2",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const state1 = state.addSetupToken(token1);
      const state2 = state1.addSetupToken(token2);

      assert.strictEqual(state2.setupTokens.length, 2);
      assert.strictEqual(state2.setupTokens[0].id, "token1");
      assert.strictEqual(state2.setupTokens[1].id, "token2");
    });

    it("preserves immutability - original state unchanged", () => {
      const tokenData = {
        id: "token123",
        token: "abc123",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const newState = state.addSetupToken(tokenData);

      assert.strictEqual(state.setupTokens.length, 0);
      assert.strictEqual(newState.setupTokens.length, 1);
    });

    it("stores different hashes for the same token value (different salts)", () => {
      const tokenData1 = { id: "t1", token: "samevalue", name: "T1", createdAt: Date.now(), lastUsedAt: null };
      const tokenData2 = { id: "t2", token: "samevalue", name: "T2", createdAt: Date.now(), lastUsedAt: null };

      const state1 = state.addSetupToken(tokenData1);
      const state2 = state1.addSetupToken(tokenData2);

      // Same plaintext → different hashes (different random salts)
      assert.notStrictEqual(state2.setupTokens[0].hash, state2.setupTokens[1].hash);
      assert.notStrictEqual(state2.setupTokens[0].salt, state2.setupTokens[1].salt);
    });
  });

  describe("findSetupToken", () => {
    it("finds token by value when not expired", () => {
      const tokenData = {
        id: "token123",
        token: "abc123def456",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("abc123def456");

      assert.ok(found !== null, "token should be found");
      assert.strictEqual(found.id, "token123");
      assert.strictEqual(found.name, "Test Token");
    });

    it("returns null if token not found", () => {
      const found = state.findSetupToken("nonexistent");
      assert.strictEqual(found, null);
    });

    it("returns null for empty string", () => {
      const tokenData = {
        id: "token123",
        token: "abc123",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("");

      assert.strictEqual(found, null);
    });

    it("returns null for null/undefined input", () => {
      const tokenData = {
        id: "token123",
        token: "abc123",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      };

      const newState = state.addSetupToken(tokenData);
      assert.strictEqual(newState.findSetupToken(null), null);
      assert.strictEqual(newState.findSetupToken(undefined), null);
    });

    it("returns null for expired token (fail-closed)", () => {
      const tokenData = {
        id: "token123",
        token: "abc123def456",
        name: "Expired Token",
        createdAt: Date.now() - 10000,
        lastUsedAt: null,
        expiresAt: Date.now() - 1,
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("abc123def456");

      assert.strictEqual(found, null, "expired token should be rejected");
    });

    it("returns null for token without expiresAt (fail-closed)", () => {
      const tokenData = {
        id: "token123",
        token: "abc123def456",
        name: "Legacy Token",
        createdAt: Date.now() - 10000,
        lastUsedAt: null,
        // No expiresAt field
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("abc123def456");

      assert.strictEqual(found, null, "token without expiresAt should be rejected (fail-closed)");
    });

    it("returns null for token expiring exactly at now", () => {
      const now = Date.now();
      const tokenData = {
        id: "token123",
        token: "abc123def456",
        name: "Just Expired",
        createdAt: now - 10000,
        lastUsedAt: null,
        expiresAt: now,
      };

      const newState = state.addSetupToken(tokenData);
      // Pass now explicitly so expiry === now (boundary: now >= expiresAt → expired)
      const found = newState.findSetupToken("abc123def456", now);

      assert.strictEqual(found, null, "token expiring exactly at now should be rejected");
    });

    it("returns token expiring 1ms in the future", () => {
      const now = Date.now();
      const tokenData = {
        id: "token123",
        token: "abc123def456",
        name: "Almost Expired",
        createdAt: now - 10000,
        lastUsedAt: null,
        expiresAt: now + 1,
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("abc123def456", now);

      assert.ok(found !== null, "token expiring 1ms in the future should be valid");
      assert.strictEqual(found.id, "token123");
    });

    it("does not find a token with wrong value", () => {
      const tokenData = {
        id: "token123",
        token: "correct-value",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("wrong-value");

      assert.strictEqual(found, null, "wrong token value should not match");
    });

    it("hash/validate round-trip works correctly", () => {
      const plaintext = "super-secret-token-value-12345";
      const tokenData = {
        id: "rt1",
        token: plaintext,
        name: "Round-trip test",
        createdAt: Date.now(),
        lastUsedAt: null,
        expiresAt: Date.now() + 10000,
      };

      const newState = state.addSetupToken(tokenData);
      // Correct value
      assert.ok(newState.findSetupToken(plaintext) !== null, "correct token should be found");
      // Off-by-one (nearly identical)
      assert.strictEqual(newState.findSetupToken(plaintext + "x"), null, "near-miss should not match");
      assert.strictEqual(newState.findSetupToken(plaintext.slice(0, -1)), null, "truncated should not match");
    });
  });

  describe("updateSetupToken", () => {
    it("updates lastUsedAt timestamp", () => {
      const tokenData = {
        id: "token123",
        token: "abc123",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const state1 = state.addSetupToken(tokenData);
      const now = Date.now();
      const state2 = state1.updateSetupToken("token123", { lastUsedAt: now });

      assert.strictEqual(state2.setupTokens[0].lastUsedAt, now);
    });

    it("updates token name", () => {
      const tokenData = {
        id: "token123",
        token: "abc123",
        name: "Old Name",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const state1 = state.addSetupToken(tokenData);
      const state2 = state1.updateSetupToken("token123", { name: "New Name" });

      assert.strictEqual(state2.setupTokens[0].name, "New Name");
    });

    it("preserves hash/salt after update", () => {
      const tokenData = {
        id: "token123",
        token: "abc123",
        name: "Test Token",
        createdAt: 12345,
        lastUsedAt: null,
      };

      const state1 = state.addSetupToken(tokenData);
      const originalHash = state1.setupTokens[0].hash;
      const originalSalt = state1.setupTokens[0].salt;
      const state2 = state1.updateSetupToken("token123", { lastUsedAt: 99999 });

      assert.strictEqual(state2.setupTokens[0].id, "token123");
      assert.strictEqual(state2.setupTokens[0].hash, originalHash, "hash should be preserved");
      assert.strictEqual(state2.setupTokens[0].salt, originalSalt, "salt should be preserved");
      assert.strictEqual(state2.setupTokens[0].name, "Test Token");
      assert.strictEqual(state2.setupTokens[0].createdAt, 12345);
      // plaintext token must not appear
      assert.strictEqual(state2.setupTokens[0].token, undefined);
    });

    it("only updates matching token", () => {
      const token1 = {
        id: "token1",
        token: "abc",
        name: "Token 1",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const token2 = {
        id: "token2",
        token: "def",
        name: "Token 2",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const state1 = state.addSetupToken(token1).addSetupToken(token2);
      const state2 = state1.updateSetupToken("token1", { name: "Updated" });

      assert.strictEqual(state2.setupTokens[0].name, "Updated");
      assert.strictEqual(state2.setupTokens[1].name, "Token 2");
    });
  });

  describe("removeSetupToken", () => {
    it("removes token by id", () => {
      const tokenData = {
        id: "token123",
        token: "abc123",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const state1 = state.addSetupToken(tokenData);
      const state2 = state1.removeSetupToken("token123");

      assert.strictEqual(state2.setupTokens.length, 0);
    });

    it("removes only matching token", () => {
      const token1 = {
        id: "token1",
        token: "abc",
        name: "Token 1",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const token2 = {
        id: "token2",
        token: "def",
        name: "Token 2",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const state1 = state.addSetupToken(token1).addSetupToken(token2);
      const state2 = state1.removeSetupToken("token1");

      assert.strictEqual(state2.setupTokens.length, 1);
      assert.strictEqual(state2.setupTokens[0].id, "token2");
    });

    it("still allows findSetupToken on remaining tokens after remove", () => {
      const token1 = { id: "t1", token: "val1", name: "T1", createdAt: Date.now(), lastUsedAt: null, expiresAt: Date.now() + 10000 };
      const token2 = { id: "t2", token: "val2", name: "T2", createdAt: Date.now(), lastUsedAt: null, expiresAt: Date.now() + 10000 };

      const state2 = state.addSetupToken(token1).addSetupToken(token2).removeSetupToken("t1");
      assert.strictEqual(state2.findSetupToken("val1"), null, "removed token should not be found");
      assert.ok(state2.findSetupToken("val2") !== null, "remaining token should still be found");
    });
  });

  describe("pruneExpiredTokens", () => {
    it("removes expired tokens", () => {
      const now = Date.now();
      const expired = { id: "t1", token: "abc", name: "Expired", createdAt: now - 20000, lastUsedAt: null, expiresAt: now - 1 };
      const valid = { id: "t2", token: "def", name: "Valid", createdAt: now - 10000, lastUsedAt: null, expiresAt: now + 10000 };

      const state1 = state.addSetupToken(expired).addSetupToken(valid);
      const state2 = state1.pruneExpiredTokens(now);

      assert.strictEqual(state2.setupTokens.length, 1);
      assert.strictEqual(state2.setupTokens[0].id, "t2");
    });

    it("removes tokens without expiresAt (fail-closed)", () => {
      const legacy = { id: "t1", token: "abc", name: "Legacy", createdAt: Date.now() - 10000, lastUsedAt: null };
      const valid = { id: "t2", token: "def", name: "Valid", createdAt: Date.now(), lastUsedAt: null, expiresAt: Date.now() + 10000 };

      const state1 = state.addSetupToken(legacy).addSetupToken(valid);
      const state2 = state1.pruneExpiredTokens();

      assert.strictEqual(state2.setupTokens.length, 1);
      assert.strictEqual(state2.setupTokens[0].id, "t2");
    });

    it("keeps all tokens when none are expired", () => {
      const now = Date.now();
      const token1 = { id: "t1", token: "abc", name: "Token 1", createdAt: now, lastUsedAt: null, expiresAt: now + 10000 };
      const token2 = { id: "t2", token: "def", name: "Token 2", createdAt: now, lastUsedAt: null, expiresAt: now + 20000 };

      const state1 = state.addSetupToken(token1).addSetupToken(token2);
      const state2 = state1.pruneExpiredTokens(now);

      assert.strictEqual(state2.setupTokens.length, 2);
    });

    it("returns empty array when all tokens are expired", () => {
      const now = Date.now();
      const token1 = { id: "t1", token: "abc", name: "Token 1", createdAt: now - 20000, lastUsedAt: null, expiresAt: now - 10000 };
      const token2 = { id: "t2", token: "def", name: "Token 2", createdAt: now - 30000, lastUsedAt: null, expiresAt: now - 1 };

      const state1 = state.addSetupToken(token1).addSetupToken(token2);
      const state2 = state1.pruneExpiredTokens(now);

      assert.strictEqual(state2.setupTokens.length, 0);
    });

    it("preserves immutability - original state unchanged", () => {
      const now = Date.now();
      const expired = { id: "t1", token: "abc", name: "Expired", createdAt: now - 20000, lastUsedAt: null, expiresAt: now - 1 };

      const state1 = state.addSetupToken(expired);
      state1.pruneExpiredTokens(now);

      assert.strictEqual(state1.setupTokens.length, 1, "original state should be unchanged");
    });
  });

  describe("empty state", () => {
    it("has empty setupTokens array", () => {
      const emptyState = AuthState.empty();
      assert.deepStrictEqual(emptyState.setupTokens, []);
    });
  });

  describe("toJSON and fromJSON", () => {
    it("serializes and deserializes hashed setup tokens (round-trip)", () => {
      const tokenData = {
        id: "token123",
        token: "plaintext-secret",
        name: "Test Token",
        createdAt: 12345,
        lastUsedAt: null,
        expiresAt: Date.now() + 10000,
      };

      const state1 = state.addSetupToken(tokenData);
      const json = state1.toJSON();
      // JSON should not contain plaintext token
      assert.strictEqual(json.setupTokens[0].token, undefined, "serialized state must not contain plaintext token");
      assert.ok(json.setupTokens[0].hash, "serialized state must contain hash");
      assert.ok(json.setupTokens[0].salt, "serialized state must contain salt");

      const { state: state2, needsMigration: migrated } = AuthState.fromJSON(json);
      // After fromJSON, findSetupToken should still work
      const found = state2.findSetupToken("plaintext-secret");
      assert.ok(found !== null, "token should be findable after serialize/deserialize");
      assert.strictEqual(found.id, "token123");
      // No migration needed (already hashed)
      assert.strictEqual(migrated, false);
    });

    it("migrates old setupToken (singular) to setupTokens (array) and hashes it", () => {
      const oldFormat = {
        user: null,
        credentials: [],
        sessions: {},
        setupToken: "old-token-value",
      };

      const { state: migratedState, needsMigration: migrated } = AuthState.fromJSON(oldFormat);

      assert.strictEqual(migratedState.setupTokens.length, 1);
      // Plaintext should be hashed
      assert.strictEqual(migratedState.setupTokens[0].token, undefined, "migrated token must not store plaintext");
      assert.ok(migratedState.setupTokens[0].hash, "migrated token must have hash");
      assert.strictEqual(migratedState.setupTokens[0].name, "Migrated Token");
      // Migration flag returned explicitly
      assert.strictEqual(migrated, true);
    });

    it("migrates legacy plaintext token strings in setupTokens array to hashed format", () => {
      // Simulate loading an old katulong-auth.json with plaintext tokens
      const legacyData = {
        user: null,
        credentials: [],
        sessions: {},
        setupTokens: [
          {
            id: "tok1",
            token: "legacy-plaintext-token",
            name: "Legacy Token",
            createdAt: Date.now() - 1000,
            lastUsedAt: null,
            expiresAt: Date.now() + 10000,
          },
        ],
      };

      const { state: migratedState, needsMigration: migrated } = AuthState.fromJSON(legacyData);

      // Token should now be hashed
      assert.strictEqual(migratedState.setupTokens[0].token, undefined, "plaintext must be removed after migration");
      assert.ok(migratedState.setupTokens[0].hash, "hash must be present after migration");
      assert.ok(migratedState.setupTokens[0].salt, "salt must be present after migration");
      // Migration flag returned explicitly so caller knows to save
      assert.strictEqual(migrated, true);

      // And we can still find the token by its original value
      const found = migratedState.findSetupToken("legacy-plaintext-token");
      assert.ok(found !== null, "migrated token should be findable by plaintext value");
      assert.strictEqual(found.id, "tok1");
    });

    it("does not set _needsMigration when tokens are already hashed", () => {
      const tokenData = {
        id: "t1",
        token: "some-value",
        name: "T",
        createdAt: Date.now(),
        lastUsedAt: null,
        expiresAt: Date.now() + 10000,
      };
      const state1 = state.addSetupToken(tokenData);
      const json = state1.toJSON();
      const { state: restored, needsMigration: migrated } = AuthState.fromJSON(json);
      assert.strictEqual(migrated, false, "no migration needed for already-hashed tokens");
    });
  });
});
