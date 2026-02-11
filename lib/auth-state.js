/**
 * AuthState - Immutable value object for authentication state
 *
 * Encapsulates user, credentials, and session management with
 * immutable operations (all methods return new instances).
 */

export class AuthState {
  /**
   * Create an AuthState
   * @param {object} data - State data
   * @param {object} data.user - User object { id, name }
   * @param {Array} data.credentials - WebAuthn credentials
   * @param {object} data.sessions - Session tokens { [token]: expiry }
   * @param {string} data.setupToken - Setup token for registering new passkeys
   */
  constructor({ user, credentials, sessions, setupToken }) {
    this.user = user;
    this.credentials = credentials || [];
    this.sessions = sessions || {};
    this.setupToken = setupToken || null;
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
      setupToken: this.setupToken,
    });
  }

  /**
   * Set or regenerate setup token (immutable)
   * @param {string} token - New setup token
   * @returns {AuthState} New state with setup token set
   */
  setSetupToken(token) {
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: this.sessions,
      setupToken: token,
    });
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
      setupToken: this.setupToken,
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
      setupToken: this.setupToken,
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
      const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
      updatedSession.expiry = now + SESSION_TTL_MS;
    }

    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: { ...this.sessions, [token]: updatedSession },
      setupToken: this.setupToken,
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
      setupToken: this.setupToken,
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
      setupToken: this.setupToken,
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
      setupToken: this.setupToken,
    });
  }

  /**
   * Remove credential (immutable)
   * Also revokes all sessions created by this credential
   * @param {string} credentialId - Credential ID to remove
   * @returns {AuthState} New state with credential and its sessions removed
   * @throws {Error} If trying to remove the last credential
   */
  removeCredential(credentialId) {
    if (this.credentials.length <= 1) {
      throw new Error('Cannot remove the last credential - would lock you out');
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
    });
  }

  /**
   * Get all credentials with metadata
   * @returns {Array} Array of credentials with full metadata
   */
  getCredentialsWithMetadata() {
    return this.credentials.map(c => ({
      id: c.id,
      name: c.name || 'Unknown Device',
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
      setupToken: this.setupToken,
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
      setupToken: null,
    });
  }

  /**
   * Create from plain object (for deserialization)
   * @param {object} data - Plain object with user, credentials, sessions
   * @returns {AuthState}
   */
  static fromJSON(data) {
    if (!data) return null;
    return new AuthState({
      user: data.user || null,
      credentials: data.credentials || [],
      sessions: data.sessions || {},
      setupToken: data.setupToken || null,
    });
  }
}
