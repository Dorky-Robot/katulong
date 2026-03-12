/**
 * AuthState - Immutable aggregate root for authentication state
 *
 * Encapsulates user, credentials, and login token management with
 * immutable operations (all methods return new instances).
 *
 * Terminology: "login tokens" are the auth session cookies that authenticate
 * remote requests. Renamed from "sessions" to avoid ambiguity with terminal
 * sessions managed by the session manager.
 */

import { randomBytes, timingSafeEqual, scryptSync } from "crypto";
import { SESSION_TTL_MS } from "./env-config.js";

export class LastCredentialError extends Error {
  constructor(message = "Cannot remove the last credential - would lock you out") {
    super(message);
    this.name = "LastCredentialError";
  }
}

// scrypt parameters (OWASP recommendation for password-like secrets)
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;

/**
 * Hash a setup token with a random salt using scrypt.
 * @param {string} token - Plaintext token value
 * @returns {{hash: string, salt: string}} Hex-encoded hash and salt
 */
function hashToken(token) {
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
function verifyToken(token, stored) {
  if (!stored || !stored.hash || !stored.salt) return false;
  const saltBuf = Buffer.from(stored.salt, "hex");
  const candidate = scryptSync(token, saltBuf, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const storedBuf = Buffer.from(stored.hash, "hex");
  if (candidate.length !== storedBuf.length) return false;
  return timingSafeEqual(candidate, storedBuf);
}

export class AuthState {
  /**
   * Create an AuthState
   * @param {object} data - State data
   * @param {object} data.user - User object { id, name }
   * @param {Array} data.credentials - WebAuthn credentials
   * @param {object} data.sessions - Login tokens { [token]: expiry } (accepts `sessions` for backward compat)
   * @param {object} data.loginTokens - Login tokens { [token]: expiry } (preferred key)
   * @param {Array} data.setupTokens - Setup tokens for registering new passkeys
   */
  constructor({ user, credentials, sessions, loginTokens, setupTokens }) {
    this.user = user ? Object.freeze({ ...user }) : user;
    this.credentials = Object.freeze((credentials || []).map(c => Object.freeze({ ...c })));
    this.loginTokens = Object.freeze({ ...(loginTokens || sessions || {}) });
    this.setupTokens = Object.freeze((setupTokens || []).map(t => Object.freeze({ ...t })));
    Object.freeze(this);
  }

  /**
   * Create a new AuthState with only the specified fields changed.
   * Reduces constructor boilerplate across all immutable mutation methods.
   */
  _with(overrides) {
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      loginTokens: this.loginTokens,
      setupTokens: this.setupTokens,
      ...overrides,
    });
  }

  /**
   * Add a credential (immutable)
   * @param {object} credential - WebAuthn credential
   * @returns {AuthState} New state with credential added
   */
  addCredential(credential) {
    return this._with({ credentials: [...this.credentials, credential] });
  }

  /**
   * Add a setup token (immutable).
   * Accepts a tokenData object with a plaintext `token` field; hashes it before storing.
   * The returned state stores {hash, salt} instead of the plaintext token.
   * @param {object} tokenData - Token object { id, token, name, createdAt, lastUsedAt, expiresAt }
   * @returns {AuthState} New state with hashed token added
   */
  addSetupToken(tokenData) {
    const { token, ...rest } = tokenData;
    const { hash, salt } = hashToken(token);
    const hashedTokenData = { ...rest, hash, salt };
    return this._with({ setupTokens: [...this.setupTokens, hashedTokenData] });
  }

  /**
   * Remove a setup token (immutable)
   * @param {string} id - Token ID
   * @returns {AuthState} New state with token removed
   */
  removeSetupToken(id) {
    return this._with({ setupTokens: this.setupTokens.filter(t => t.id !== id) });
  }

  /**
   * Update a setup token (immutable)
   * @param {string} id - Token ID
   * @param {object} updates - Updates to apply
   * @returns {AuthState} New state with token updated
   */
  updateSetupToken(id, updates) {
    return this._with({ setupTokens: this.setupTokens.map(t => t.id === id ? { ...t, ...updates } : t) });
  }

  /**
   * Find a setup token by value using constant-time comparison to prevent timing attacks.
   * Iterates all tokens without short-circuiting to avoid leaking which token matched.
   * Fail-closed: tokens without expiresAt are treated as expired.
   * @param {string} tokenValue - Token string
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {object|null} Token object or null if not found or expired
   */
  findSetupToken(tokenValue, now = Date.now()) {
    if (!tokenValue) return null;
    let found = null;
    for (const t of this.setupTokens) {
      let match = false;
      if (t.hash && t.salt) {
        // Hashed token: use scrypt verification
        match = verifyToken(tokenValue, t);
      } else if (typeof t.token === "string") {
        // Legacy plaintext token: constant-time string comparison
        const candidateBuf = Buffer.from(tokenValue);
        const tokenBuf = Buffer.from(t.token);
        if (candidateBuf.length === tokenBuf.length && candidateBuf.length > 0) {
          match = timingSafeEqual(candidateBuf, tokenBuf);
        } else {
          // Consume constant time even when lengths differ
          timingSafeEqual(tokenBuf.length > 0 ? tokenBuf : Buffer.alloc(1), tokenBuf.length > 0 ? tokenBuf : Buffer.alloc(1));
        }
      }
      if (match && found === null) {
        found = t;
      }
    }
    // Fail-closed: reject tokens without expiresAt or that have expired
    if (found !== null && (!found.expiresAt || now >= found.expiresAt)) {
      return null;
    }
    return found;
  }

  /**
   * Add a login token (immutable)
   * @param {string} token - Login token
   * @param {number} expiry - Expiry timestamp
   * @param {string} credentialId - Credential ID that created this login token
   * @param {string} csrfToken - CSRF token for this login token (optional for backward compatibility)
   * @param {number} lastActivityAt - Last activity timestamp (optional for backward compatibility)
   * @returns {AuthState} New state with login token added
   */
  addLoginToken(token, expiry, credentialId = null, csrfToken = null, lastActivityAt = null) {
    return this._with({ loginTokens: { ...this.loginTokens, [token]: { expiry, credentialId, csrfToken, lastActivityAt } } });
  }

  /**
   * Remove a login token (immutable)
   * @param {string} token - Login token to remove
   * @returns {AuthState} New state with login token removed
   */
  removeLoginToken(token) {
    const { [token]: _, ...remainingTokens } = this.loginTokens;
    return this._with({ loginTokens: remainingTokens });
  }

  /**
   * Update login token activity (immutable)
   * @param {string} token - Login token
   * @param {number} now - Current timestamp (default: Date.now())
   * @param {number} refreshThresholdMs - Refresh expiry if activity was longer than this (default: 24h)
   * @returns {AuthState} New state with updated login token activity
   */
  updateLoginTokenActivity(token, now = Date.now(), refreshThresholdMs = 24 * 60 * 60 * 1000) {
    const loginToken = this.loginTokens[token];
    if (!loginToken) return this; // Login token doesn't exist, return unchanged

    const lastActivity = loginToken.lastActivityAt || 0;
    const timeSinceActivity = now - lastActivity;

    let updatedToken = { ...loginToken, lastActivityAt: now };

    // If activity was more than threshold ago, extend expiry (sliding window)
    if (timeSinceActivity > refreshThresholdMs) {
      updatedToken.expiry = now + SESSION_TTL_MS;
    }

    return this._with({ loginTokens: { ...this.loginTokens, [token]: updatedToken } });
  }

  /**
   * Remove all login tokens (immutable)
   * @returns {AuthState} New state with no login tokens
   */
  revokeAllLoginTokens() {
    return this._with({ loginTokens: {} });
  }

  /**
   * Prune expired login tokens (immutable)
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {AuthState} New state with expired login tokens removed
   */
  pruneExpired(now = Date.now()) {
    const loginTokens = Object.fromEntries(
      Object.entries(this.loginTokens).filter(([_, loginToken]) => {
        const expiry = typeof loginToken === 'number' ? loginToken : loginToken.expiry;
        return expiry > now;
      })
    );
    return this._with({ loginTokens });
  }

  /**
   * Prune expired setup tokens (immutable).
   * Fail-closed: tokens without expiresAt are treated as expired.
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {AuthState} New state with expired setup tokens removed
   */
  pruneExpiredTokens(now = Date.now()) {
    const setupTokens = this.setupTokens.filter(t => t.expiresAt && now < t.expiresAt);
    return this._with({ setupTokens });
  }

  /**
   * Check if a login token is valid
   * @param {string} token - Login token
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {boolean}
   */
  isValidLoginToken(token, now = Date.now()) {
    if (!token) return false;
    const loginToken = this.loginTokens[token];
    if (!loginToken) return false;

    // Reject old format login tokens (just a number) - should have been migrated
    if (typeof loginToken === 'number') return false;

    // Reject old object login tokens without credentialId property (created before tracking)
    if (!('credentialId' in loginToken)) return false;

    // Check expiry
    if (now >= loginToken.expiry) return false;

    // Whitelist validation: ALL login tokens must have a valid credential
    // (pairing now creates credentials, so credentialId: null is invalid)
    if (!loginToken.credentialId) {
      return false; // Reject old pairing login tokens without credentials
    }

    const credentialExists = this.credentials.some(c => c.id === loginToken.credentialId);
    if (!credentialExists) return false;

    return true;
  }

  /**
   * Get a login token by token string
   * @param {string} token - Login token
   * @returns {object|null} Login token object or null if not found
   */
  getLoginToken(token) {
    if (!token) return null;
    const loginToken = this.loginTokens[token];
    if (!loginToken) return null;
    // Reject old format login tokens (just a number)
    if (typeof loginToken === 'number') return null;
    return loginToken;
  }

  /**
   * Get all valid (non-expired) login tokens
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {string[]}
   */
  getValidLoginTokens(now = Date.now()) {
    return Object.entries(this.loginTokens)
      .filter(([_, loginToken]) => {
        const expiry = typeof loginToken === 'number' ? loginToken : loginToken.expiry;
        return expiry > now;
      })
      .map(([token, _]) => token);
  }

  /**
   * Count active login tokens
   * @returns {number}
   */
  loginTokenCount() {
    return Object.keys(this.loginTokens).length;
  }

  /**
   * Check if user is registered
   * @returns {boolean}
   */
  hasUser() {
    return this.user !== null && this.user !== undefined;
  }

  /**
   * Check if any credentials exist
   * @returns {boolean}
   */
  hasCredentials() {
    return this.credentials.length > 0;
  }

  /**
   * Get credential by ID
   * @param {string} credentialId - Credential ID to find
   * @returns {object|null} Credential object or null if not found
   */
  getCredential(credentialId) {
    return this.credentials.find(c => c.id === credentialId) || null;
  }

  /**
   * Update credential metadata (immutable)
   * @param {string} credentialId - Credential ID to update
   * @param {object} updates - Metadata updates (name, lastUsedAt, etc.)
   * @returns {AuthState} New state with updated credential
   */
  updateCredential(credentialId, updates) {
    const credentials = this.credentials.map(c =>
      c.id === credentialId ? { ...c, ...updates } : c
    );
    return this._with({ credentials });
  }

  /**
   * Remove credential (immutable)
   * Also revokes all sessions created by this credential
   * @param {string} credentialId - Credential ID to remove
   * @param {Object} [options]
   * @param {boolean} [options.allowRemoveLast=false] - Allow removing the last credential (e.g. from localhost)
   * @returns {AuthState} New state with credential and its sessions removed
   * @throws {Error} If trying to remove the last credential without allowRemoveLast
   */
  removeCredential(credentialId, { allowRemoveLast = false } = {}) {
    if (this.credentials.length <= 1 && !allowRemoveLast) {
      throw new LastCredentialError();
    }
    const credentials = this.credentials.filter(c => c.id !== credentialId);

    // Revoke login tokens created by this credential
    // Also revoke old-format login tokens (can't verify ownership, so safer to remove them)
    const loginTokens = Object.fromEntries(
      Object.entries(this.loginTokens).filter(([_, loginToken]) => {
        // Remove old format login tokens (safer - we can't verify which credential they belong to)
        if (typeof loginToken === 'number') return false;
        // Keep login tokens that don't belong to this credential
        return loginToken.credentialId !== credentialId;
      })
    );

    return this._with({ credentials, loginTokens });
  }

  /**
   * End session (destructive logout - immutable)
   * Removes the credential AND all sessions created by that credential
   * Also removes setup tokens linked to the credential
   *
   * REQUIREMENT: "End Session" permanently removes the credential and all sessions.
   * This is different from logout which only removes the session.
   * User expectation: Clicking "End Session" means "I'm done with this device,
   * remove it completely." To use the terminal again, they must re-pair.
   *
   * @param {string} sessionToken - Session token to end
   * @param {Object} [options]
   * @param {boolean} [options.allowRemoveLast=false] - Allow ending session for the last credential (e.g. from localhost)
   * @returns {{ state: AuthState, removedCredentialId: string|null }} Result object with new state and removed credential ID
   * @throws {Error} If trying to end session for the last credential without allowRemoveLast
   */
  endSession(sessionToken, { allowRemoveLast = false } = {}) {
    const loginToken = this.loginTokens[sessionToken];

    // If login token doesn't exist, return unchanged state
    if (!loginToken) {
      return { state: this, removedCredentialId: null };
    }

    // If login token has no credentialId (orphan), just remove the login token
    if (!loginToken.credentialId) {
      return { state: this.removeLoginToken(sessionToken), removedCredentialId: null };
    }

    const credentialId = loginToken.credentialId;

    // Prevent removing last credential (lockout protection)
    if (this.credentials.length <= 1 && !allowRemoveLast) {
      throw new LastCredentialError('Cannot end session for the last credential - would lock you out');
    }

    // Remove credential
    const credentials = this.credentials.filter(c => c.id !== credentialId);

    // Remove all login tokens for this credential
    const loginTokens = Object.fromEntries(
      Object.entries(this.loginTokens).filter(([_, lt]) => {
        // Remove old format login tokens
        if (typeof lt === 'number') return false;
        // Keep login tokens that don't belong to this credential
        return lt.credentialId !== credentialId;
      })
    );

    // Remove setup tokens linked to this credential
    const setupTokens = this.setupTokens.filter(t => t.credentialId !== credentialId);

    return { state: this._with({ credentials, loginTokens, setupTokens }), removedCredentialId: credentialId };
  }

  /**
   * Get all credentials with metadata
   * @returns {Array} Array of credentials with full metadata
   */
  getCredentialsWithMetadata() {
    return this.credentials.map(c => ({
      id: c.id,
      name: c.name || 'Unknown Device',
      type: c.type || null,
      deviceId: c.deviceId || null,
      createdAt: c.createdAt || null,
      lastUsedAt: c.lastUsedAt || null,
      userAgent: c.userAgent || 'Unknown',
      transports: c.transports || [],
    }));
  }

  /**
   * Migrate credentials missing device metadata (immutable)
   * @param {number} now - Current timestamp
   * @returns {{ state: AuthState, migrated: boolean }}
   */
  migrateCredentialMetadata(now = Date.now()) {
    let migrated = false;
    const credentials = this.credentials.map((cred, index) => {
      if (cred.deviceId !== undefined && cred.name !== undefined) return cred;
      migrated = true;
      return {
        ...cred,
        deviceId: cred.deviceId || null,
        name: cred.name || `Device ${index + 1}`,
        createdAt: cred.createdAt || now,
        lastUsedAt: cred.lastUsedAt || now,
        userAgent: cred.userAgent || 'Unknown',
      };
    });
    if (!migrated) return { state: this, migrated: false };
    return { state: this._with({ credentials }), migrated: true };
  }

  /**
   * Remove orphaned login tokens — old format, missing credentialId, or dangling references (immutable)
   * @returns {{ state: AuthState, cleaned: boolean }}
   */
  cleanOrphanedLoginTokens() {
    const validCredentialIds = new Set(this.credentials.map(c => c.id));
    let cleaned = false;
    const loginTokens = Object.fromEntries(
      Object.entries(this.loginTokens).filter(([_, loginToken]) => {
        if (typeof loginToken === 'number') { cleaned = true; return false; }
        if (!('credentialId' in loginToken)) { cleaned = true; return false; }
        if (loginToken.credentialId === null) { cleaned = true; return false; }
        if (!validCredentialIds.has(loginToken.credentialId)) { cleaned = true; return false; }
        return true;
      })
    );
    if (!cleaned) return { state: this, cleaned: false };
    return { state: this._with({ loginTokens }), cleaned: true };
  }

  /**
   * Add lastActivityAt to login tokens that don't have it (immutable)
   * @param {number} now - Current timestamp
   * @returns {{ state: AuthState, migrated: boolean }}
   */
  migrateLoginTokenActivity(now = Date.now()) {
    let migrated = false;
    const loginTokens = Object.fromEntries(
      Object.entries(this.loginTokens).map(([token, loginToken]) => {
        if (loginToken.lastActivityAt) return [token, loginToken];
        migrated = true;
        return [token, { ...loginToken, lastActivityAt: now }];
      })
    );
    if (!migrated) return { state: this, migrated: false };
    return { state: this._with({ loginTokens }), migrated: true };
  }

  /**
   * Serialize to plain object (for persistence)
   * @returns {object}
   */
  toJSON() {
    return {
      user: this.user,
      credentials: this.credentials,
      sessions: this.loginTokens,
      setupTokens: this.setupTokens,
    };
  }

  /**
   * Create empty state (no user, no credentials, no login tokens)
   * @param {string} userId - Optional user ID
   * @param {string} userName - Optional user name (default: "owner")
   * @returns {AuthState}
   */
  static empty(userId = null, userName = "owner") {
    return new AuthState({
      user: userId ? { id: userId, name: userName } : null,
      credentials: [],
      loginTokens: {},
      setupTokens: [],
    });
  }

  /**
   * Create from plain object (for deserialization).
   * Handles two migration paths:
   *   1. Old `setupToken` singular string → new setupTokens array format
   *   2. Legacy plaintext `token` strings in setupTokens → hashed {hash, salt} format
   * @param {object} data - Plain object with user, credentials, sessions
   * @returns {{ state: AuthState|null, needsMigration: boolean }}
   */
  static fromJSON(data) {
    if (!data) return { state: null, needsMigration: false };

    // Migrate old setupToken (string) to new setupTokens (array) format
    let setupTokens = data.setupTokens || [];
    if (!setupTokens.length && data.setupToken) {
      // Convert old format to new format (plaintext — will be migrated below)
      setupTokens = [{
        id: randomBytes(8).toString("hex"),
        token: data.setupToken,
        name: "Migrated Token",
        createdAt: Date.now(),
        lastUsedAt: null,
      }];
    }

    // Migrate legacy plaintext token strings to hashed {hash, salt} format.
    // Detect entries that still have a plaintext `token` field and hash them.
    let needsMigration = false;
    setupTokens = setupTokens.map(t => {
      if (typeof t.token === "string") {
        // Plaintext token — hash it now
        needsMigration = true;
        const { token, ...rest } = t;
        const { hash, salt } = hashToken(token);
        return { ...rest, hash, salt };
      }
      return t;
    });

    const state = new AuthState({
      user: data.user || null,
      credentials: data.credentials || [],
      loginTokens: data.sessions || {},
      setupTokens,
    });

    return { state, needsMigration };
  }
}
