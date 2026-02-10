import { describe, it } from "node:test";
import assert from "node:assert";
import { PairingChallenge, PairingChallengeStore } from "../lib/pairing-challenge.js";

describe("PairingChallenge", () => {
  describe("generate", () => {
    it("creates a challenge with UUID code", () => {
      const challenge = PairingChallenge.generate();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assert.ok(uuidRegex.test(challenge.code));
    });

    it("creates a challenge with 8-digit PIN", () => {
      const challenge = PairingChallenge.generate();
      assert.strictEqual(challenge.pin.length, 8);
      assert.ok(/^\d{8}$/.test(challenge.pin));
      const pinNum = parseInt(challenge.pin, 10);
      assert.ok(pinNum >= 10000000 && pinNum <= 99999999);
    });

    it("sets expiry timestamp based on TTL", () => {
      const beforeGen = Date.now();
      const challenge = PairingChallenge.generate(5000); // 5 seconds TTL
      const afterGen = Date.now();

      assert.ok(challenge.expiresAt >= beforeGen + 5000);
      assert.ok(challenge.expiresAt <= afterGen + 5000);
    });

    it("uses default TTL of 30 seconds", () => {
      const beforeGen = Date.now();
      const challenge = PairingChallenge.generate();
      const afterGen = Date.now();

      assert.ok(challenge.expiresAt >= beforeGen + 30000);
      assert.ok(challenge.expiresAt <= afterGen + 30000);
    });

    it("generates unique codes and PINs", () => {
      const challenges = Array.from({ length: 10 }, () => PairingChallenge.generate());
      const codes = new Set(challenges.map((c) => c.code));
      const pins = new Set(challenges.map((c) => c.pin));

      // All codes should be unique (UUID collision extremely unlikely)
      assert.strictEqual(codes.size, 10);

      // Most PINs should be unique (collision possible but rare)
      assert.ok(pins.size >= 8);
    });
  });

  describe("isExpired", () => {
    it("returns false for future expiry", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() + 10000);
      assert.strictEqual(challenge.isExpired(), false);
    });

    it("returns true for past expiry", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() - 1000);
      assert.strictEqual(challenge.isExpired(), true);
    });

    it("returns true when exactly at expiry time", () => {
      const now = Date.now();
      const challenge = new PairingChallenge("test-code", "12345678", now);

      // Wait a tiny bit to ensure we're past expiry
      const start = Date.now();
      while (Date.now() - start < 1) {} // Busy wait 1ms

      assert.strictEqual(challenge.isExpired(), true);
    });
  });

  describe("verify", () => {
    it("returns valid: true for correct PIN", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() + 10000);
      const result = challenge.verify("12345678");
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.reason, undefined);
    });

    it("returns valid: false for incorrect PIN", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() + 10000);
      const result = challenge.verify("87654321");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "wrong-pin");
    });

    it("normalizes PIN by stripping non-digits", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() + 10000);
      const result = challenge.verify("12-34-56-78");
      assert.strictEqual(result.valid, true);
    });

    it("returns invalid-format for too short PIN", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() + 10000);
      const result = challenge.verify("1234567");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "invalid-format");
    });

    it("returns invalid-format for too long PIN", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() + 10000);
      const result = challenge.verify("123456789");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "invalid-format");
    });

    it("returns invalid-format for non-numeric PIN", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() + 10000);
      const result = challenge.verify("abcdefgh");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "invalid-format");
    });

    it("returns invalid-format for empty PIN after normalization", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() + 10000);
      const result = challenge.verify("---");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "invalid-format");
    });

    it("handles numeric PIN input", () => {
      const challenge = new PairingChallenge("test-code", "12345678", Date.now() + 10000);
      const result = challenge.verify(12345678);
      assert.strictEqual(result.valid, true);
    });
  });

  describe("toJSON", () => {
    it("serializes to object with code, pin, expiresAt", () => {
      const expiresAt = Date.now() + 10000;
      const challenge = new PairingChallenge("test-code", "12345678", expiresAt);
      const json = challenge.toJSON();

      assert.deepStrictEqual(json, {
        code: "test-code",
        pin: "12345678",
        expiresAt,
      });
    });

    it("works with JSON.stringify", () => {
      const expiresAt = Date.now() + 10000;
      const challenge = new PairingChallenge("test-code", "12345678", expiresAt);
      const json = JSON.stringify(challenge);

      assert.strictEqual(json, `{"code":"test-code","pin":"12345678","expiresAt":${expiresAt}}`);
    });
  });
});

describe("PairingChallengeStore", () => {
  describe("create", () => {
    it("creates and stores a new challenge", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();

      assert.ok(challenge instanceof PairingChallenge);
      assert.ok(store.challenges.has(challenge.code));
    });

    it("uses default TTL of 30 seconds", () => {
      const store = new PairingChallengeStore();
      const beforeCreate = Date.now();
      const challenge = store.create();
      const afterCreate = Date.now();

      assert.ok(challenge.expiresAt >= beforeCreate + 30000);
      assert.ok(challenge.expiresAt <= afterCreate + 30000);
    });

    it("uses custom TTL when provided", () => {
      const store = new PairingChallengeStore(5000);
      const beforeCreate = Date.now();
      const challenge = store.create();
      const afterCreate = Date.now();

      assert.ok(challenge.expiresAt >= beforeCreate + 5000);
      assert.ok(challenge.expiresAt <= afterCreate + 5000);
    });

    it("sweeps expired challenges before creating new one", () => {
      const store = new PairingChallengeStore(10);
      const challenge1 = store.create();

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 20) {} // Busy wait 20ms

      const challenge2 = store.create();

      assert.strictEqual(store.size(), 1);
      assert.ok(!store.challenges.has(challenge1.code));
      assert.ok(store.challenges.has(challenge2.code));
    });
  });

  describe("consume", () => {
    it("returns valid: true for correct code and PIN", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();

      const result = store.consume(challenge.code, challenge.pin);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.reason, undefined);
    });

    it("removes challenge after successful consumption", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();

      store.consume(challenge.code, challenge.pin);

      assert.strictEqual(store.size(), 0);
      assert.ok(!store.challenges.has(challenge.code));
    });

    it("removes challenge even when PIN is wrong (single-attempt)", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();

      store.consume(challenge.code, "000000");

      assert.strictEqual(store.size(), 0);
    });

    it("returns not-found for unknown code", () => {
      const store = new PairingChallengeStore();
      const result = store.consume("00000000-0000-0000-0000-000000000000", "12345678");

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "not-found");
    });

    it("returns expired for expired challenge", () => {
      const store = new PairingChallengeStore(10);
      const challenge = store.create();

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 20) {} // Busy wait 20ms

      const result = store.consume(challenge.code, challenge.pin);

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "expired");
    });

    it("returns wrong-pin for incorrect PIN", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();

      const result = store.consume(challenge.code, "00000000");

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "wrong-pin");
    });

    it("returns invalid-code-format for non-UUID code", () => {
      const store = new PairingChallengeStore();
      const result = store.consume("not-a-uuid", "12345678");

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "invalid-code-format");
    });

    it("returns invalid-code-format for null code", () => {
      const store = new PairingChallengeStore();
      const result = store.consume(null, "12345678");

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "invalid-code-format");
    });

    it("returns missing-pin for null PIN", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();
      const result = store.consume(challenge.code, null);

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "missing-pin");
    });

    it("returns invalid-format for invalid PIN format", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();
      const result = store.consume(challenge.code, "1234567"); // Only 5 digits

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "invalid-format");
    });
  });

  describe("sweep", () => {
    it("removes expired challenges", () => {
      const store = new PairingChallengeStore(10);
      const challenge1 = store.create();

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 20) {} // Busy wait 20ms

      const challenge2 = store.create(); // Should trigger sweep
      store.sweep(); // Explicit sweep

      assert.strictEqual(store.size(), 1);
      assert.ok(store.challenges.has(challenge2.code));
    });

    it("keeps non-expired challenges", () => {
      const store = new PairingChallengeStore(10000);
      const challenge1 = store.create();
      const challenge2 = store.create();

      store.sweep();

      assert.strictEqual(store.size(), 2);
      assert.ok(store.challenges.has(challenge1.code));
      assert.ok(store.challenges.has(challenge2.code));
    });
  });

  describe("size", () => {
    it("returns 0 for empty store", () => {
      const store = new PairingChallengeStore();
      assert.strictEqual(store.size(), 0);
    });

    it("returns correct count after adding challenges", () => {
      const store = new PairingChallengeStore();
      store.create();
      store.create();
      store.create();

      assert.strictEqual(store.size(), 3);
    });

    it("returns correct count after consuming challenges", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();
      store.create();

      store.consume(challenge.code, challenge.pin);

      assert.strictEqual(store.size(), 1);
    });
  });

  describe("real-world pairing flow", () => {
    it("handles complete pairing flow", () => {
      const store = new PairingChallengeStore();

      // Device A creates pairing challenge
      const challenge = store.create();
      assert.ok(challenge.code);
      assert.ok(challenge.pin);

      // Device B receives code and enters PIN
      const result = store.consume(challenge.code, challenge.pin);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(store.size(), 0);
    });

    it("prevents PIN reuse", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();

      // First attempt succeeds
      const result1 = store.consume(challenge.code, challenge.pin);
      assert.strictEqual(result1.valid, true);

      // Second attempt fails (challenge consumed)
      const result2 = store.consume(challenge.code, challenge.pin);
      assert.strictEqual(result2.valid, false);
      assert.strictEqual(result2.reason, "not-found");
    });

    it("prevents brute-force by deleting on wrong PIN", () => {
      const store = new PairingChallengeStore();
      const challenge = store.create();

      // Wrong PIN deletes challenge
      const result1 = store.consume(challenge.code, "000000");
      assert.strictEqual(result1.valid, false);

      // Can't retry with correct PIN
      const result2 = store.consume(challenge.code, challenge.pin);
      assert.strictEqual(result2.valid, false);
      assert.strictEqual(result2.reason, "not-found");
    });
  });
});
