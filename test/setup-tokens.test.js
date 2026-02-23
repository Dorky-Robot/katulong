import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { AuthState, SETUP_TOKEN_TTL_MS } from "../lib/auth-state.js";

describe("Setup Tokens", () => {
  let state;

  beforeEach(() => {
    state = AuthState.empty();
  });

  describe("addSetupToken", () => {
    it("adds a setup token to empty state", () => {
      const tokenData = {
        id: "token123",
        token: "abc123def456",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const newState = state.addSetupToken(tokenData);

      assert.strictEqual(newState.setupTokens.length, 1);
      assert.deepStrictEqual(newState.setupTokens[0], tokenData);
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
      assert.deepStrictEqual(state2.setupTokens[0], token1);
      assert.deepStrictEqual(state2.setupTokens[1], token2);
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
  });

  describe("findSetupToken", () => {
    it("finds token by value", () => {
      const tokenData = {
        id: "token123",
        token: "abc123def456",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("abc123def456");

      assert.deepStrictEqual(found, tokenData);
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
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("");

      assert.strictEqual(found, null);
    });

    it("returns null for an expired token (past TTL)", () => {
      const expiredCreatedAt = Date.now() - SETUP_TOKEN_TTL_MS - 1;
      const tokenData = {
        id: "expired-token",
        token: "expired-token-value",
        name: "Expired Token",
        createdAt: expiredCreatedAt,
        lastUsedAt: null,
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("expired-token-value");

      assert.strictEqual(found, null);
    });

    it("returns token when exactly within TTL", () => {
      const recentCreatedAt = Date.now() - SETUP_TOKEN_TTL_MS + 1000; // 1 second before expiry
      const tokenData = {
        id: "fresh-token",
        token: "fresh-token-value",
        name: "Fresh Token",
        createdAt: recentCreatedAt,
        lastUsedAt: null,
      };

      const newState = state.addSetupToken(tokenData);
      const found = newState.findSetupToken("fresh-token-value");

      assert.deepStrictEqual(found, tokenData);
    });

    it("accepts injectable `now` to test expiration boundary", () => {
      const createdAt = 1000;
      const tokenData = {
        id: "t1",
        token: "some-token",
        name: "Token",
        createdAt,
        lastUsedAt: null,
      };

      const newState = state.addSetupToken(tokenData);

      // Just before expiry: token is valid
      assert.deepStrictEqual(newState.findSetupToken("some-token", createdAt + SETUP_TOKEN_TTL_MS - 1), tokenData);

      // Exactly at expiry boundary (diff === TTL): expired
      assert.strictEqual(newState.findSetupToken("some-token", createdAt + SETUP_TOKEN_TTL_MS), null);

      // After expiry: null
      assert.strictEqual(newState.findSetupToken("some-token", createdAt + SETUP_TOKEN_TTL_MS + 1), null);
    });

    it("does not expire tokens without createdAt (backward compat)", () => {
      const tokenData = {
        id: "legacy-token",
        token: "legacy-value",
        name: "Legacy Token",
        createdAt: null, // old tokens may lack createdAt
        lastUsedAt: null,
      };

      const newState = state.addSetupToken(tokenData);
      // A very far future `now` should not expire a token with no createdAt
      const found = newState.findSetupToken("legacy-value", Date.now() + 999999999);

      assert.deepStrictEqual(found, tokenData);
    });

    it("returns null for a revoked (removed) token", () => {
      const tokenData = {
        id: "revoked-token",
        token: "revocable-value",
        name: "Revocable Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const stateWithToken = state.addSetupToken(tokenData);
      assert.ok(stateWithToken.findSetupToken("revocable-value"), "token should be findable before revocation");

      // Simulate revocation (e.g. token deleted between /register/options and /register/verify)
      const stateAfterRevocation = stateWithToken.removeSetupToken("revoked-token");
      const found = stateAfterRevocation.findSetupToken("revocable-value");

      assert.strictEqual(found, null);
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

    it("preserves other token properties", () => {
      const tokenData = {
        id: "token123",
        token: "abc123",
        name: "Test Token",
        createdAt: 12345,
        lastUsedAt: null,
      };

      const state1 = state.addSetupToken(tokenData);
      const state2 = state1.updateSetupToken("token123", { lastUsedAt: 99999 });

      assert.strictEqual(state2.setupTokens[0].id, "token123");
      assert.strictEqual(state2.setupTokens[0].token, "abc123");
      assert.strictEqual(state2.setupTokens[0].name, "Test Token");
      assert.strictEqual(state2.setupTokens[0].createdAt, 12345);
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
  });

  describe("empty state", () => {
    it("has empty setupTokens array", () => {
      const emptyState = AuthState.empty();
      assert.deepStrictEqual(emptyState.setupTokens, []);
    });
  });

  describe("toJSON and fromJSON", () => {
    it("serializes and deserializes setup tokens", () => {
      const tokenData = {
        id: "token123",
        token: "abc123",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      };

      const state1 = state.addSetupToken(tokenData);
      const json = state1.toJSON();
      const state2 = AuthState.fromJSON(json);

      assert.deepStrictEqual(state2.setupTokens, [tokenData]);
    });

    it("migrates old setupToken (singular) to setupTokens (array)", () => {
      const oldFormat = {
        user: null,
        credentials: [],
        sessions: {},
        setupToken: "old-token-value",
      };

      const state = AuthState.fromJSON(oldFormat);

      assert.strictEqual(state.setupTokens.length, 1);
      assert.strictEqual(state.setupTokens[0].token, "old-token-value");
      assert.strictEqual(state.setupTokens[0].name, "Migrated Token");
    });
  });
});
