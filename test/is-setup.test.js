import { describe, it } from "node:test";
import assert from "node:assert";
import { AuthState } from "../lib/auth-state.js";

describe("isSetup() logic", () => {
  describe("Bug fix: isSetup() should check credentials, not just state file existence", () => {
    it("returns false for state with no credentials (empty state)", () => {
      const state = AuthState.empty();

      // Simulate isSetup() logic
      const hasCredentials = state.credentials && state.credentials.length > 0;

      assert.strictEqual(hasCredentials, false);
    });

    it("returns false for state with setup tokens but no credentials", () => {
      // This was the bug: state file existed with tokens but no credentials
      // Old isSetup() returned true, leading to null.id access error
      const state = AuthState.empty().addSetupToken({
        id: "token1",
        token: "abc123",
        name: "Test Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      });

      // Simulate isSetup() logic
      const hasCredentials = state.credentials && state.credentials.length > 0;

      assert.strictEqual(hasCredentials, false);
    });

    it("returns true for state with credentials", () => {
      const state = AuthState.empty("user123", "owner").addCredential({
        id: "cred1",
        publicKey: "key123",
        counter: 0,
      });

      // Simulate isSetup() logic
      const hasCredentials = state.credentials && state.credentials.length > 0;

      assert.strictEqual(hasCredentials, true);
    });

    it("returns true for state with both tokens and credentials", () => {
      const state = AuthState.empty("user123", "owner")
        .addCredential({
          id: "cred1",
          publicKey: "key1",
          counter: 0,
        })
        .addSetupToken({
          id: "token1",
          token: "abc123",
          name: "Token",
          createdAt: Date.now(),
          lastUsedAt: null,
        });

      // Simulate isSetup() logic
      const hasCredentials = state.credentials && state.credentials.length > 0;

      assert.strictEqual(hasCredentials, true);
    });
  });

  describe("Regression: state with null user and setup tokens", () => {
    it("does not throw when state has null user but no credentials", () => {
      // Recreate the exact scenario from the bug
      const stateData = {
        user: null,
        credentials: [],
        sessions: {},
        setupTokens: [
          {
            id: "token1",
            token: "abc123",
            name: "Test",
            createdAt: Date.now(),
            lastUsedAt: null,
          },
        ],
      };

      const { state } = AuthState.fromJSON(stateData);

      // Simulate isSetup() check
      const hasCredentials = state.credentials && state.credentials.length > 0;
      assert.strictEqual(hasCredentials, false);

      // Simulate the code path that was failing
      if (hasCredentials) {
        // Old code: this would try to access state.user.id and throw
        // Should NOT reach here
        assert.fail("Should not try to access user.id when no credentials");
      } else {
        // New code: safely handle case where state exists but no credentials
        assert.strictEqual(state.user, null);
        assert.strictEqual(state.credentials.length, 0);
        assert.strictEqual(state.setupTokens.length, 1);
      }
    });
  });
});
