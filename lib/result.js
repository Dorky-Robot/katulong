/**
 * Generic Result Types
 *
 * Provides type-safe success/failure result objects for operations that can fail.
 * Usage: check `.success` to determine outcome, then read `.data` or `.message`.
 */

/**
 * Success result with optional data payload
 * @template T
 */
export class Success {
  /**
   * @param {T} data - Success data payload
   */
  constructor(data) {
    this.success = true;
    this.data = data;
  }
}

/**
 * Failure result with reason and message
 */
export class Failure {
  /**
   * @param {string} reason - Machine-readable failure reason
   * @param {string} message - Human-readable error message
   * @param {number} [statusCode=400] - HTTP status code (optional)
   * @param {object} [metadata] - Additional error metadata (optional)
   */
  constructor(reason, message, statusCode = 400, metadata = {}) {
    this.success = false;
    this.reason = reason;
    this.message = message;
    this.statusCode = statusCode;
    this.metadata = metadata;
  }
}
