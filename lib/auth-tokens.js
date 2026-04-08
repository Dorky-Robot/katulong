/**
 * Token hashing for auth secrets (setup tokens, API keys).
 *
 * Extracted from auth-state.js because scrypt hashing is a standalone
 * cryptographic concern with no dependencies on the AuthState aggregate.
 * Keeping it here:
 *   - Makes the crypto parameters (SCRYPT_N / R / P / KEY_LEN) legible
 *     as their own unit, separate from AuthState's 600+ lines of
 *     immutable-record plumbing.
 *   - Lets the hash/verify functions be unit-tested in isolation.
 *   - Keeps auth-state.js focused on "what is the current auth state"
 *     rather than "how do we store token secrets safely".
 *
 * These helpers are exported so auth-state.js (and only auth-state.js)
 * can call them. If another module ever needs to hash a token, it
 * should import from here — do NOT recreate the parameters inline or
 * the hashes will be mutually unverifiable.
 *
 * Parameters are OWASP's scrypt recommendation for password-equivalent
 * secrets. Do not lower them without a migration plan: stored hashes
 * carry only the salt, not the parameters, so changing N/r/p would
 * invalidate every persisted setup token and API key.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// scrypt parameters (OWASP recommendation for password-like secrets)
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;

/**
 * Hash a token with a random salt using scrypt.
 * @param {string} token - Plaintext token value
 * @returns {{hash: string, salt: string}} Hex-encoded hash and salt
 */
export function hashToken(token) {
  const salt = randomBytes(16);
  const hash = scryptSync(token, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return {
    hash: hash.toString("hex"),
    salt: salt.toString("hex"),
  };
}

/**
 * Verify a plaintext token against a stored hashed token entry.
 * Uses constant-time comparison to prevent timing attacks.
 * @param {string} token - Plaintext token to verify
 * @param {{hash: string, salt: string}} stored - Stored hash entry
 * @returns {boolean}
 */
export function verifyToken(token, stored) {
  if (!stored || !stored.hash || !stored.salt) return false;
  const saltBuf = Buffer.from(stored.salt, "hex");
  const candidate = scryptSync(token, saltBuf, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const storedBuf = Buffer.from(stored.hash, "hex");
  if (candidate.length !== storedBuf.length) return false;
  return timingSafeEqual(candidate, storedBuf);
}
