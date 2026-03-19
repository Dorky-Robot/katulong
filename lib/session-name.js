/**
 * SessionName - Value object for terminal session names
 *
 * Ensures session names are valid, safe, and normalized.
 * Allows all printable ASCII (space through ~, codes 32-126).
 * Control characters and non-ASCII are stripped.
 * Limited to 64 characters.
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

    // Keep all printable ASCII (space through ~), strip everything else
    const sanitized = String(raw).replace(/[^ -~]/g, "").trim().slice(0, 64);

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
