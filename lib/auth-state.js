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
   */
  constructor({ user, credentials, sessions }) {
    this.user = user;
    this.credentials = credentials || [];
    this.sessions = sessions || {};
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
    });
  }

  /**
   * Add a session token (immutable)
   * @param {string} token - Session token
   * @param {number} expiry - Expiry timestamp
   * @returns {AuthState} New state with session added
   */
  addSession(token, expiry) {
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions: { ...this.sessions, [token]: expiry },
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
    });
  }

  /**
   * Prune expired sessions (immutable)
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {AuthState} New state with expired sessions removed
   */
  pruneExpired(now = Date.now()) {
    const sessions = Object.fromEntries(
      Object.entries(this.sessions).filter(([_, expiry]) => expiry > now)
    );
    return new AuthState({
      user: this.user,
      credentials: this.credentials,
      sessions,
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
    const expiry = this.sessions[token];
    if (!expiry) return false;
    return now < expiry;
  }

  /**
   * Get all valid (non-expired) session tokens
   * @param {number} now - Current timestamp (default: Date.now())
   * @returns {string[]}
   */
  getValidSessions(now = Date.now()) {
    return Object.entries(this.sessions)
      .filter(([_, expiry]) => expiry > now)
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
   * Serialize to plain object (for persistence)
   * @returns {object}
   */
  toJSON() {
    return {
      user: this.user,
      credentials: this.credentials,
      sessions: this.sessions,
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
    });
  }
}
