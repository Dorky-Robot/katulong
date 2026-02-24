/**
 * AuthState - Immutable value object for authentication state
 *
 * Encapsulates user, credentials, and session management with
 * immutable operations (all methods return new instances).
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
   * @param {object} data.sessions - Session tokens { [token]: expiry }
   * @param {Array} data.setupTokens - Setup tokens for registering new passkeys
   */
  constructor({ user, credentials, sessions, setupTokens }) {
    this.user = user;
    this.credentials = credentials || [];
    this.sessions = sessions || {};
    this.setupTokens = setupTokens || [];
  }

  /**
   * Add a credential (immutable)
   * @param {object} credential - WebAuthn credential
   * @returns {AuthState} New state with credential added
   */
  addCredential(credential) {
    return new AuthState({
      user: this.user,
      credentials: [...this.credentials, credential],
      sessions: this.sessions,
      setupTokens: this.setupTokens,
    });
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
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: this.sessions,
      setupTokens: [...this.setupTokens, hashedTokenData],
    });
  }

  /**
   * Remove a setup token (immutable)
   * @param {string} id - Token ID
   * @returns {AuthState} New state with token removed
   */
  removeSetupToken(id) {
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: this.sessions,
      setupTokens: this.setupTokens.filter(t => t.id !== id),
    });
  }

  /**
   * Update a setup token (immutable)
   * @param {string} id - Token ID
   * @param {object} updates - Updates to apply
   * @returns {AuthState} New state with token updated
   */
  updateSetupToken(id, updates) {
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: this.sessions,
      setupTokens: this.setupTokens.map(t => t.id === id ? { ...t, ...updates } : t),
    });
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
   * Add a session token (immutable)
   * @param {string} token - Session token
   * @param {number} expiry - Expiry timestamp
   * @param {string} credentialId - Credential ID that created this session
   * @param {string} csrfToken - CSRF token for this session (optional for backward compatibility)
   * @param {number} lastActivityAt - Last activity timestamp (optional for backward compatibility)
   * @returns {AuthState} New state with session added
   */
  addSession(token, expiry, credentialId = null, csrfToken = null, lastActivityAt = null) {
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: { ...this.sessions, [token]: { expiry, credentialId, csrfToken, lastActivityAt } },
      setupTokens: this.setupTokens,
    });
  }

  /**
   * Remove a session token (immutable)
   * @param {string} token - Session token to remove
   * @returns {AuthState} New state with session removed
   */
  removeSession(token) {
    const { [token]: _, ...remainingSessions } = this.sessions;
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: remainingSessions,
      setupTokens: this.setupTokens,
    });
  }

  /**
   * Update session activity (immutable)
   * @param {string} token - Session token
   * @param {number} now - Current timestamp (default: Date.now())
   * @param {number} refreshThresholdMs - Refresh expiry if activity was longer than this (default: 24h)
   * @returns {AuthState} New state with updated session activity
   */
  updateSessionActivity(token, now = Date.now(), refreshThresholdMs = 24 * 60 * 60 * 1000) {
    const session = this.sessions[token];
    if (!session) return this; // Session doesn't exist, return unchanged

    const lastActivity = session.lastActivityAt || 0;
    const timeSinceActivity = now - lastActivity;

    let updatedSession = { ...session, lastActivityAt: now };

    // If activity was more than threshold ago, extend expiry (sliding window)
    if (timeSinceActivity > refreshThresholdMs) {
      updatedSession.expiry = now + SESSION_TTL_MS;
    }

    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: { ...this.sessions, [token]: updatedSession },
      setupTokens: this.setupTokens,
    });
  }

  /**
   * Remove all sessions (immutable)
   * @returns {AuthState} New state with no sessions
   */
  revokeAllSessions() {
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: {},
      setupTokens: this.setupTokens,
    });
  }

  /**
   * Prune expired sessions (immutable)
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {AuthState} New state with expired sessions removed
   */
  pruneExpired(now = Date.now()) {
    const sessions = Object.fromEntries(
      Object.entries(this.sessions).filter(([_, session]) => {
        const expiry = typeof session === 'number' ? session : session.expiry;
        return expiry > now;
      })
    );
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions,
      setupTokens: this.setupTokens,
    });
  }

  /**
   * Prune expired setup tokens (immutable).
   * Fail-closed: tokens without expiresAt are treated as expired.
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {AuthState} New state with expired setup tokens removed
   */
  pruneExpiredTokens(now = Date.now()) {
    const setupTokens = this.setupTokens.filter(t => t.expiresAt && now < t.expiresAt);
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: this.sessions,
      setupTokens,
    });
  }

  /**
   * Check if a session token is valid
   * @param {string} token - Session token
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {boolean}
   */
  isValidSession(token, now = Date.now()) {
    if (!token) return false;
    const session = this.sessions[token];
    if (!session) return false;

    // Reject old format sessions (just a number) - should have been migrated
    if (typeof session === 'number') return false;

    // Reject old object sessions without credentialId property (created before tracking)
    if (!('credentialId' in session)) return false;

    // Check expiry
    if (now >= session.expiry) return false;

    // Whitelist validation: ALL sessions must have a valid credential
    // (pairing now creates credentials, so credentialId: null is invalid)
    if (!session.credentialId) {
      return false; // Reject old pairing sessions without credentials
    }

    const credentialExists = this.credentials.some(c => c.id === session.credentialId);
    if (!credentialExists) return false;

    return true;
  }

  /**
   * Get a session by token
   * @param {string} token - Session token
   * @returns {object|null} Session object or null if not found
   */
  getSession(token) {
    if (!token) return null;
    const session = this.sessions[token];
    if (!session) return null;
    // Reject old format sessions (just a number)
    if (typeof session === 'number') return null;
    return session;
  }

  /**
   * Get all valid (non-expired) session tokens
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {string[]}
   */
  getValidSessions(now = Date.now()) {
    return Object.entries(this.sessions)
      .filter(([_, session]) => {
        const expiry = typeof session === 'number' ? session : session.expiry;
        return expiry > now;
      })
      .map(([token, _]) => token);
  }

  /**
   * Count active sessions
   * @returns {number}
   */
  sessionCount() {
    return Object.keys(this.sessions).length;
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
    return new AuthState({
      user: this.user,
      credentials,
      sessions: this.sessions,
      setupTokens: this.setupTokens,
    });
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

    // Revoke sessions created by this credential
    // Also revoke old-format sessions (can't verify ownership, so safer to remove them)
    const sessions = Object.fromEntries(
      Object.entries(this.sessions).filter(([_, session]) => {
        // Remove old format sessions (safer - we can't verify which credential they belong to)
        if (typeof session === 'number') return false;
        // Keep sessions that don't belong to this credential
        return session.credentialId !== credentialId;
      })
    );

    return new AuthState({
      user: this.user,
      credentials,
      sessions,
      setupTokens: this.setupTokens,
    });
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
    const session = this.sessions[sessionToken];

    // If session doesn't exist, return unchanged state
    if (!session) {
      return { state: this, removedCredentialId: null };
    }

    // If session has no credentialId (orphan), just remove the session
    if (!session.credentialId) {
      return { state: this.removeSession(sessionToken), removedCredentialId: null };
    }

    const credentialId = session.credentialId;

    // Prevent removing last credential (lockout protection)
    if (this.credentials.length <= 1 && !allowRemoveLast) {
      throw new LastCredentialError('Cannot end session for the last credential - would lock you out');
    }

    // Remove credential
    const credentials = this.credentials.filter(c => c.id !== credentialId);

    // Remove all sessions for this credential
    const sessions = Object.fromEntries(
      Object.entries(this.sessions).filter(([_, s]) => {
        // Remove old format sessions
        if (typeof s === 'number') return false;
        // Keep sessions that don't belong to this credential
        return s.credentialId !== credentialId;
      })
    );

    // Remove setup tokens linked to this credential
    const setupTokens = this.setupTokens.filter(t => t.credentialId !== credentialId);

    const newState = new AuthState({
      user: this.user,
      credentials,
      sessions,
      setupTokens,
    });

    return { state: newState, removedCredentialId: credentialId };
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
   * Serialize to plain object (for persistence)
   * @returns {object}
   */
  toJSON() {
    return {
      user: this.user,
      credentials: this.credentials,
      sessions: this.sessions,
      setupTokens: this.setupTokens,
    };
  }

  /**
   * Create empty state (no user, no credentials, no sessions)
   * @param {string} userId - Optional user ID
   * @param {string} userName - Optional user name (default: "owner")
   * @returns {AuthState}
   */
  static empty(userId = null, userName = "owner") {
    return new AuthState({
      user: userId ? { id: userId, name: userName } : null,
      credentials: [],
      sessions: {},
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
      sessions: data.sessions || {},
      setupTokens,
    });

    return { state, needsMigration };
  }
}
