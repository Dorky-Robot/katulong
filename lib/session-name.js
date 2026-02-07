/**
 * SessionName - Value object for terminal session names
 *
 * Ensures session names are valid, safe, and normalized.
 * Session names can only contain alphanumeric characters, hyphens, and underscores,
 * and are limited to 64 characters.
 */

export class InvalidSessionNameError extends Error {
  constructor(raw) {
    super(`Invalid session name: "${raw}"`);
    this.name = "InvalidSessionNameError";
    this.raw = raw;
  }
}

export class SessionName {
  /**
   * Create a SessionName from a raw string
   * @param {any} raw - Raw input to sanitize and validate
   * @throws {InvalidSessionNameError} If the input produces an invalid name
   */
  constructor(raw) {
    if (!raw || typeof raw !== "string") {
      throw new InvalidSessionNameError(raw);
    }

    const sanitized = String(raw).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

    if (!sanitized) {
      throw new InvalidSessionNameError(raw);
    }

    this.value = sanitized;
  }

  /**
   * Safely create a SessionName or return null if invalid
   * @param {any} raw - Raw input
   * @returns {SessionName | null}
   */
  static tryCreate(raw) {
    try {
      return new SessionName(raw);
    } catch (err) {
      if (err instanceof InvalidSessionNameError) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Get the string value
   * @returns {string}
   */
  toString() {
    return this.value;
  }

  /**
   * Check equality with another SessionName
   * @param {SessionName | string} other
   * @returns {boolean}
   */
  equals(other) {
    if (other instanceof SessionName) {
      return other.value === this.value;
    }
    if (typeof other === "string") {
      return other === this.value;
    }
    return false;
  }

  /**
   * For JSON serialization
   * @returns {string}
   */
  toJSON() {
    return this.value;
  }
}
