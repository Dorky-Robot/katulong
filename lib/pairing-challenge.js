import { randomBytes, randomUUID } from "node:crypto";

/**
 * PairingChallenge - Domain model for device pairing challenges
 *
 * Encapsulates the logic for generating, validating, and verifying
 * short-lived pairing challenges with 8-digit PINs.
 */

const PIN_MIN = 10000000; // 8-digit PIN minimum value
const PIN_MAX = 99999999; // 8-digit PIN maximum value
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PairingChallenge {
  /**
   * Create a new pairing challenge
   * @param {string} code - UUID code
   * @param {string} pin - 8-digit PIN
   * @param {number} expiresAt - Unix timestamp when challenge expires
   */
  constructor(code, pin, expiresAt) {
    this.code = code;
    this.pin = pin;
    this.expiresAt = expiresAt;
  }

  /**
   * Generate a new pairing challenge
   * @param {number} ttlMs - Time-to-live in milliseconds (default: 30 seconds)
   * @returns {PairingChallenge}
   */
  static generate(ttlMs = 30000) {
    const code = randomUUID();
    const pin = String(PIN_MIN + (randomBytes(4).readUInt32BE() % (PIN_MAX - PIN_MIN + 1)));
    const expiresAt = Date.now() + ttlMs;
    return new PairingChallenge(code, pin, expiresAt);
  }

  /**
   * Check if the challenge has expired
   * @returns {boolean}
   */
  isExpired() {
    return Date.now() >= this.expiresAt;
  }

  /**
   * Verify a submitted PIN against the challenge
   * @param {string} submittedPin - PIN to verify
   * @returns {{ valid: boolean, reason?: string }}
   */
  verify(submittedPin) {
    // Normalize: strip non-digits
    const normalized = String(submittedPin).replace(/\D/g, "");

    // Validate PIN format (exactly 8 digits)
    if (normalized.length !== 8 || !/^\d{8}$/.test(normalized)) {
      return { valid: false, reason: "invalid-format" };
    }

    // Check PIN match
    if (this.pin !== normalized) {
      return { valid: false, reason: "wrong-pin" };
    }

    return { valid: true };
  }

  /**
   * Serialize to JSON for API responses
   * @returns {object}
   */
  toJSON() {
    return {
      code: this.code,
      pin: this.pin,
      expiresAt: this.expiresAt,
    };
  }
}

/**
 * PairingChallengeStore - Repository for managing pairing challenges
 *
 * Provides storage, retrieval, and automatic cleanup of pairing challenges.
 */
export class PairingChallengeStore {
  /**
   * Create a new challenge store
   * @param {number} ttlMs - Default time-to-live for challenges (default: 30 seconds)
   */
  constructor(ttlMs = 30000) {
    this.challenges = new Map();
    this.consumed = new Map(); // Track consumed codes: code -> timestamp
    this.ttlMs = ttlMs;
  }

  /**
   * Create and store a new pairing challenge
   * @returns {PairingChallenge}
   */
  create() {
    this.sweep();
    const challenge = PairingChallenge.generate(this.ttlMs);
    this.challenges.set(challenge.code, challenge);
    return challenge;
  }

  /**
   * Verify a code and PIN, consuming the challenge
   * @param {string} code - Challenge code (UUID)
   * @param {string} pin - PIN to verify
   * @returns {{ valid: boolean, reason?: string }}
   */
  consume(code, pin) {
    // Validate code format (UUID)
    if (!code || !UUID_REGEX.test(String(code))) {
      return { valid: false, reason: "invalid-code-format" };
    }

    // Validate PIN presence
    if (!pin) {
      return { valid: false, reason: "missing-pin" };
    }

    const challenge = this.challenges.get(code);
    if (!challenge) {
      return { valid: false, reason: "not-found" };
    }

    // Delete immediately to prevent reuse (single-attempt)
    this.challenges.delete(code);

    // Check expiry
    if (challenge.isExpired()) {
      return { valid: false, reason: "expired" };
    }

    // Verify PIN
    const result = challenge.verify(pin);

    // Track successful consumption for status polling (keep for 60s)
    if (result.valid) {
      this.consumed.set(code, Date.now() + 60000);
    }

    return result;
  }

  /**
   * Check if a code was successfully consumed
   * @param {string} code - Challenge code to check
   * @returns {boolean}
   */
  wasConsumed(code) {
    const expiresAt = this.consumed.get(code);
    if (!expiresAt) return false;
    if (Date.now() >= expiresAt) {
      this.consumed.delete(code);
      return false;
    }
    return true;
  }

  /**
   * Remove expired challenges and consumed codes
   */
  sweep() {
    const now = Date.now();
    // Clean up expired challenges
    for (const [code, challenge] of this.challenges) {
      if (now >= challenge.expiresAt) {
        this.challenges.delete(code);
      }
    }
    // Clean up old consumed codes
    for (const [code, expiresAt] of this.consumed) {
      if (now >= expiresAt) {
        this.consumed.delete(code);
      }
    }
  }

  /**
   * Get the number of active challenges
   * @returns {number}
   */
  size() {
    return this.challenges.size;
  }
}
