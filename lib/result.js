/**
 * Generic Result Types for Functional Core Pattern
 *
 * Provides type-safe success/failure result objects for operations that can fail.
 * Eliminates the need for custom Success/Failure classes in each module.
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

  /**
   * Check if result is success
   * @returns {boolean}
   */
  isSuccess() {
    return true;
  }

  /**
   * Check if result is failure
   * @returns {boolean}
   */
  isFailure() {
    return false;
  }

  /**
   * Get data or throw if failure
   * @returns {T}
   */
  unwrap() {
    return this.data;
  }

  /**
   * Get data or default value
   * @param {T} defaultValue
   * @returns {T}
   */
  unwrapOr(defaultValue) {
    return this.data;
  }

  /**
   * Map success value with function
   * @template U
   * @param {function(T): U} fn
   * @returns {Success<U>}
   */
  map(fn) {
    return new Success(fn(this.data));
  }

  /**
   * Chain operations that return Results
   * @template U
   * @param {function(T): Success<U>|Failure} fn
   * @returns {Success<U>|Failure}
   */
  flatMap(fn) {
    return fn(this.data);
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

  /**
   * Check if result is success
   * @returns {boolean}
   */
  isSuccess() {
    return false;
  }

  /**
   * Check if result is failure
   * @returns {boolean}
   */
  isFailure() {
    return true;
  }

  /**
   * Get data or throw if failure
   * @throws {Error}
   */
  unwrap() {
    throw new Error(`${this.reason}: ${this.message}`);
  }

  /**
   * Get data or default value
   * @template T
   * @param {T} defaultValue
   * @returns {T}
   */
  unwrapOr(defaultValue) {
    return defaultValue;
  }

  /**
   * Map does nothing on Failure (returns self)
   * @returns {Failure}
   */
  map() {
    return this;
  }

  /**
   * FlatMap does nothing on Failure (returns self)
   * @returns {Failure}
   */
  flatMap() {
    return this;
  }
}

/**
 * Type guard to check if result is Success
 * @template T
 * @param {Success<T>|Failure} result
 * @returns {result is Success<T>}
 */
export function isSuccess(result) {
  return result.success === true;
}

/**
 * Type guard to check if result is Failure
 * @param {Success|Failure} result
 * @returns {result is Failure}
 */
export function isFailure(result) {
  return result.success === false;
}

/**
 * Create a Success result
 * @template T
 * @param {T} data
 * @returns {Success<T>}
 */
export function success(data) {
  return new Success(data);
}

/**
 * Create a Failure result
 * @param {string} reason
 * @param {string} message
 * @param {number} [statusCode=400]
 * @param {object} [metadata={}]
 * @returns {Failure}
 */
export function failure(reason, message, statusCode = 400, metadata = {}) {
  return new Failure(reason, message, statusCode, metadata);
}
