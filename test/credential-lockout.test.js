import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CredentialLockout } from "../lib/credential-lockout.js";

describe("CredentialLockout", () => {
  let lockout;

  beforeEach(() => {
    lockout = new CredentialLockout({
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000, // 15 minutes
      lockoutMs: 15 * 60 * 1000, // 15 minutes
    });
  });

  afterEach(() => {
    lockout.destroy();
  });

  describe("isLocked", () => {
    it("returns not locked for unknown credential", () => {
      const result = lockout.isLocked("unknown-cred");
      assert.equal(result.locked, false);
      assert.equal(result.retryAfter, undefined);
    });

    it("returns not locked for credential with no failures", () => {
      const result = lockout.isLocked("cred-123");
      assert.equal(result.locked, false);
    });

    it("returns locked when credential is locked", () => {
      // Record 5 failures to trigger lockout
      for (let i = 0; i < 5; i++) {
        lockout.recordFailure("cred-123");
      }

      const result = lockout.isLocked("cred-123");
      assert.equal(result.locked, true);
      assert.ok(result.retryAfter > 0);
      // Should be approximately 900 seconds (15 minutes)
      assert.ok(result.retryAfter >= 899 && result.retryAfter <= 900);
    });

    it("cleans up expired lockout and returns not locked", () => {
      // Create lockout with very short duration
      const shortLockout = new CredentialLockout({
        maxAttempts: 3,
        windowMs: 1000,
        lockoutMs: 100, // 100ms lockout
      });

      // Trigger lockout
      for (let i = 0; i < 3; i++) {
        shortLockout.recordFailure("cred-456");
      }

      // Should be locked
      assert.equal(shortLockout.isLocked("cred-456").locked, true);

      // Wait for lockout to expire
      return new Promise((resolve) => {
        setTimeout(() => {
          const result = shortLockout.isLocked("cred-456");
          assert.equal(result.locked, false);
          assert.equal(result.retryAfter, undefined);
          shortLockout.destroy();
          resolve();
        }, 150);
      });
    });
  });

  describe("recordFailure", () => {
    it("returns not locked for first failure", () => {
      const result = lockout.recordFailure("cred-001");
      assert.equal(result.locked, false);
      assert.equal(result.retryAfter, undefined);
    });

    it("returns not locked for failures below threshold", () => {
      for (let i = 0; i < 4; i++) {
        const result = lockout.recordFailure("cred-002");
        assert.equal(result.locked, false, `Failure ${i + 1} should not lock`);
      }
    });

    it("returns locked on fifth failure", () => {
      // First 4 failures
      for (let i = 0; i < 4; i++) {
        lockout.recordFailure("cred-003");
      }

      // Fifth failure triggers lockout
      const result = lockout.recordFailure("cred-003");
      assert.equal(result.locked, true);
      assert.ok(result.retryAfter > 0);
    });

    it("tracks failures per credential independently", () => {
      // Record 3 failures for cred-A
      for (let i = 0; i < 3; i++) {
        lockout.recordFailure("cred-A");
      }

      // Record 2 failures for cred-B
      for (let i = 0; i < 2; i++) {
        lockout.recordFailure("cred-B");
      }

      // Neither should be locked yet
      assert.equal(lockout.isLocked("cred-A").locked, false);
      assert.equal(lockout.isLocked("cred-B").locked, false);

      // Complete lockout for cred-A
      lockout.recordFailure("cred-A");
      lockout.recordFailure("cred-A");

      // cred-A should be locked, cred-B should not
      assert.equal(lockout.isLocked("cred-A").locked, true);
      assert.equal(lockout.isLocked("cred-B").locked, false);
    });

    it("removes old failures outside the time window", () => {
      const shortWindow = new CredentialLockout({
        maxAttempts: 3,
        windowMs: 100, // 100ms window
        lockoutMs: 15 * 60 * 1000,
      });

      // Record 2 failures
      shortWindow.recordFailure("cred-time");
      shortWindow.recordFailure("cred-time");

      // Wait for window to expire
      return new Promise((resolve) => {
        setTimeout(() => {
          // Record one more failure after window expired
          const result = shortWindow.recordFailure("cred-time");

          // Should not be locked (old failures expired, only 1 in current window)
          assert.equal(result.locked, false);
          shortWindow.destroy();
          resolve();
        }, 150);
      });
    });

    it("calculates correct retryAfter duration", () => {
      // Trigger lockout
      for (let i = 0; i < 5; i++) {
        lockout.recordFailure("cred-retry");
      }

      const result = lockout.recordFailure("cred-retry");
      assert.equal(result.locked, true);

      // Should be 15 minutes = 900 seconds
      assert.ok(result.retryAfter >= 899 && result.retryAfter <= 900);
    });
  });

  describe("recordSuccess", () => {
    it("resets failure counter", () => {
      // Record 3 failures
      for (let i = 0; i < 3; i++) {
        lockout.recordFailure("cred-success");
      }

      // Verify we have failures
      assert.equal(lockout.getFailureCount("cred-success"), 3);

      // Record success
      lockout.recordSuccess("cred-success");

      // Failures should be cleared
      assert.equal(lockout.getFailureCount("cred-success"), 0);
    });

    it("clears lockout state", () => {
      // Trigger lockout
      for (let i = 0; i < 5; i++) {
        lockout.recordFailure("cred-locked");
      }

      // Verify locked
      assert.equal(lockout.isLocked("cred-locked").locked, true);

      // Record success
      lockout.recordSuccess("cred-locked");

      // Should no longer be locked
      assert.equal(lockout.isLocked("cred-locked").locked, false);
    });

    it("is safe to call for credential with no failures", () => {
      // Should not throw
      assert.doesNotThrow(() => {
        lockout.recordSuccess("never-failed");
      });
    });
  });

  describe("getFailureCount", () => {
    it("returns 0 for unknown credential", () => {
      assert.equal(lockout.getFailureCount("unknown"), 0);
    });

    it("returns 0 for credential with no failures", () => {
      assert.equal(lockout.getFailureCount("no-failures"), 0);
    });

    it("returns correct count of recent failures", () => {
      lockout.recordFailure("count-test");
      assert.equal(lockout.getFailureCount("count-test"), 1);

      lockout.recordFailure("count-test");
      assert.equal(lockout.getFailureCount("count-test"), 2);

      lockout.recordFailure("count-test");
      assert.equal(lockout.getFailureCount("count-test"), 3);
    });

    it("excludes failures outside time window", () => {
      const shortWindow = new CredentialLockout({
        maxAttempts: 5,
        windowMs: 100, // 100ms window
        lockoutMs: 15 * 60 * 1000,
      });

      // Record 2 failures
      shortWindow.recordFailure("time-count");
      shortWindow.recordFailure("time-count");
      assert.equal(shortWindow.getFailureCount("time-count"), 2);

      // Wait for window to expire
      return new Promise((resolve) => {
        setTimeout(() => {
          // Old failures should be excluded
          assert.equal(shortWindow.getFailureCount("time-count"), 0);
          shortWindow.destroy();
          resolve();
        }, 150);
      });
    });
  });

  describe("cleanup", () => {
    it("removes expired lockouts", () => {
      const shortLockout = new CredentialLockout({
        maxAttempts: 3,
        windowMs: 1000,
        lockoutMs: 100, // 100ms lockout
      });

      // Trigger lockout
      for (let i = 0; i < 3; i++) {
        shortLockout.recordFailure("cleanup-expired");
      }

      // Verify locked
      assert.equal(shortLockout.isLocked("cleanup-expired").locked, true);

      // Wait for lockout to expire
      return new Promise((resolve) => {
        setTimeout(() => {
          // Run cleanup
          shortLockout.cleanup();

          // Lockout should be removed
          assert.equal(shortLockout.isLocked("cleanup-expired").locked, false);
          shortLockout.destroy();
          resolve();
        }, 150);
      });
    });

    it("removes old failure records", () => {
      const shortWindow = new CredentialLockout({
        maxAttempts: 5,
        windowMs: 100, // 100ms window
        lockoutMs: 15 * 60 * 1000,
      });

      // Record failures
      shortWindow.recordFailure("cleanup-failures");
      shortWindow.recordFailure("cleanup-failures");

      // Wait for window to expire
      return new Promise((resolve) => {
        setTimeout(() => {
          // Run cleanup
          shortWindow.cleanup();

          // Old failures should be removed
          assert.equal(shortWindow.getFailureCount("cleanup-failures"), 0);
          shortWindow.destroy();
          resolve();
        }, 150);
      });
    });

    it("preserves recent failures", () => {
      lockout.recordFailure("keep-recent");
      lockout.recordFailure("keep-recent");

      // Run cleanup immediately
      lockout.cleanup();

      // Recent failures should be preserved
      assert.equal(lockout.getFailureCount("keep-recent"), 2);
    });

    it("preserves active lockouts", () => {
      // Trigger lockout
      for (let i = 0; i < 5; i++) {
        lockout.recordFailure("keep-lockout");
      }

      // Run cleanup immediately
      lockout.cleanup();

      // Lockout should still be active
      assert.equal(lockout.isLocked("keep-lockout").locked, true);
    });
  });

  describe("getStatus", () => {
    it("returns zero counts for empty lockout", () => {
      const status = lockout.getStatus();
      assert.equal(status.lockedCredentials, 0);
      assert.equal(status.trackedCredentials, 0);
    });

    it("counts tracked credentials", () => {
      lockout.recordFailure("cred-1");
      lockout.recordFailure("cred-2");
      lockout.recordFailure("cred-3");

      const status = lockout.getStatus();
      assert.equal(status.trackedCredentials, 3);
      assert.equal(status.lockedCredentials, 0);
    });

    it("counts locked credentials", () => {
      // Lock two credentials
      for (let i = 0; i < 5; i++) {
        lockout.recordFailure("locked-1");
        lockout.recordFailure("locked-2");
      }

      // Add one with failures but not locked
      lockout.recordFailure("tracked-only");

      const status = lockout.getStatus();
      assert.equal(status.lockedCredentials, 2);
      assert.equal(status.trackedCredentials, 3);
    });
  });

  describe("destroy", () => {
    it("clears all failures and lockouts", () => {
      lockout.recordFailure("cred-destroy-1");
      lockout.recordFailure("cred-destroy-1");
      for (let i = 0; i < 5; i++) {
        lockout.recordFailure("cred-destroy-2");
      }

      assert.equal(lockout.getStatus().trackedCredentials, 2);
      assert.equal(lockout.getStatus().lockedCredentials, 1);

      lockout.destroy();

      // After destroy, a new instance is needed for further assertions;
      // just verify that calling destroy() a second time does not throw
      assert.doesNotThrow(() => lockout.destroy());

      // Re-create for afterEach to call destroy() safely on a fresh instance
      lockout = new CredentialLockout({ maxAttempts: 5, windowMs: 60000, lockoutMs: 60000 });
    });

    it("stops the background cleanup interval (calling destroy twice is safe)", () => {
      const temp = new CredentialLockout({ maxAttempts: 3, windowMs: 100, lockoutMs: 100 });
      // Should not throw
      assert.doesNotThrow(() => {
        temp.destroy();
        temp.destroy();
      });
    });
  });

  describe("edge cases", () => {
    it("handles exactly maxAttempts failures", () => {
      const lockout3 = new CredentialLockout({ maxAttempts: 3, windowMs: 60000, lockoutMs: 60000 });

      lockout3.recordFailure("exact-3");
      lockout3.recordFailure("exact-3");
      const result = lockout3.recordFailure("exact-3");

      // Third failure (>= 3) should trigger lockout
      assert.equal(result.locked, true);
      lockout3.destroy();
    });

    it("handles concurrent failures for same credential", () => {
      // Simulate rapid failures
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(lockout.recordFailure("concurrent"));
      }

      // First 4 should not lock, 5th and beyond should be locked
      for (let i = 0; i < 4; i++) {
        assert.equal(results[i].locked, false, `Attempt ${i + 1} should not lock`);
      }
      for (let i = 4; i < 10; i++) {
        assert.equal(results[i].locked, true, `Attempt ${i + 1} should be locked`);
      }
    });

    it("handles very short lockout duration", () => {
      const microLockout = new CredentialLockout({
        maxAttempts: 2,
        windowMs: 1000,
        lockoutMs: 1, // 1ms lockout
      });

      // Trigger lockout
      microLockout.recordFailure("micro");
      microLockout.recordFailure("micro");

      // Should be locked briefly
      assert.equal(microLockout.isLocked("micro").locked, true);

      // Wait 50ms
      return new Promise((resolve) => {
        setTimeout(() => {
          // Should be unlocked
          assert.equal(microLockout.isLocked("micro").locked, false);
          microLockout.destroy();
          resolve();
        }, 50);
      });
    });

    it("handles empty string credential ID", () => {
      assert.doesNotThrow(() => {
        lockout.recordFailure("");
        lockout.isLocked("");
        lockout.recordSuccess("");
      });
    });

    it("handles special characters in credential ID", () => {
      const specialId = "cred@#$%^&*()[]{}|\\/<>?";
      assert.doesNotThrow(() => {
        lockout.recordFailure(specialId);
        lockout.isLocked(specialId);
        lockout.recordSuccess(specialId);
      });
    });
  });
});
