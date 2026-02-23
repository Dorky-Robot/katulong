/**
 * Credential Lockout Tracker
 *
 * Tracks failed authentication attempts per credential and locks accounts
 * after too many failures. Helps prevent brute-force attacks on credentials.
 */

export class CredentialLockout {
  /**
   * Create a new credential lockout tracker
   * @param {object} options - Configuration options
   * @param {number} options.maxAttempts - Maximum failed attempts before lockout (default: 5)
   * @param {number} options.windowMs - Time window for counting failures in ms (default: 15 minutes)
   * @param {number} options.lockoutMs - Lockout duration in ms (default: 15 minutes)
   */
  constructor({ maxAttempts = 5, windowMs = 15 * 60 * 1000, lockoutMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;

    // Track failed attempts: credentialId -> array of failure timestamps
    this.failures = new Map();

    // Track lockout end times: credentialId -> timestamp when lockout expires
    this.lockouts = new Map();

    // Periodic cleanup.
    // The interval is unref()d so it never prevents the process from exiting.
    this._cleanupInterval = setInterval(() => this.cleanup(), windowMs);
    this._cleanupInterval.unref();
  }

  /**
   * Check if a credential is currently locked out
   * @param {string} credentialId - Credential ID to check
   * @returns {{ locked: boolean, retryAfter?: number }}
   */
  isLocked(credentialId) {
    const lockoutEnd = this.lockouts.get(credentialId);
    if (!lockoutEnd) return { locked: false };

    const now = Date.now();
    if (now >= lockoutEnd) {
      // Lockout expired
      this.lockouts.delete(credentialId);
      this.failures.delete(credentialId);
      return { locked: false };
    }

    // Still locked
    const retryAfter = Math.ceil((lockoutEnd - now) / 1000);
    return { locked: true, retryAfter };
  }

  /**
   * Record a failed authentication attempt
   * @param {string} credentialId - Credential ID that failed
   * @returns {{ locked: boolean, retryAfter?: number }}
   */
  recordFailure(credentialId) {
    const now = Date.now();

    // Get existing failures for this credential
    const failures = this.failures.get(credentialId) || [];

    // Remove failures outside the time window
    const recentFailures = failures.filter(timestamp => now - timestamp < this.windowMs);

    // Add this failure
    recentFailures.push(now);
    this.failures.set(credentialId, recentFailures);

    // Check if we've hit the limit
    if (recentFailures.length >= this.maxAttempts) {
      const lockoutEnd = now + this.lockoutMs;
      this.lockouts.set(credentialId, lockoutEnd);

      const retryAfter = Math.ceil(this.lockoutMs / 1000);
      return { locked: true, retryAfter };
    }

    return { locked: false };
  }

  /**
   * Record a successful authentication (resets failure counter)
   * @param {string} credentialId - Credential ID that succeeded
   */
  recordSuccess(credentialId) {
    this.failures.delete(credentialId);
    this.lockouts.delete(credentialId);
  }

  /**
   * Clean up expired lockouts and old failure records
   */
  cleanup() {
    const now = Date.now();

    // Clean up expired lockouts
    for (const [credentialId, lockoutEnd] of this.lockouts) {
      if (now >= lockoutEnd) {
        this.lockouts.delete(credentialId);
        this.failures.delete(credentialId);
      }
    }

    // Clean up old failure records (outside the window)
    for (const [credentialId, failures] of this.failures) {
      const recentFailures = failures.filter(timestamp => now - timestamp < this.windowMs);
      if (recentFailures.length === 0) {
        this.failures.delete(credentialId);
      } else {
        this.failures.set(credentialId, recentFailures);
      }
    }
  }

  /**
   * Get failure count for a credential
   * @param {string} credentialId - Credential ID
   * @returns {number} Number of recent failures
   */
  getFailureCount(credentialId) {
    const failures = this.failures.get(credentialId);
    if (!failures) return 0;

    const now = Date.now();
    const recentFailures = failures.filter(timestamp => now - timestamp < this.windowMs);
    return recentFailures.length;
  }

  /**
   * Get lockout status for debugging
   * @returns {object} Current state
   */
  getStatus() {
    return {
      lockedCredentials: this.lockouts.size,
      trackedCredentials: this.failures.size,
    };
  }

  /**
   * Stop the background cleanup interval and clear all stored state.
   * Call this in test teardown or server shutdown to avoid leaked timers.
   */
  destroy() {
    clearInterval(this._cleanupInterval);
    this._cleanupInterval = null;
    this.failures.clear();
    this.lockouts.clear();
  }
}
