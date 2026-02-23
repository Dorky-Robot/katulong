/**
 * WebSocket message validation
 *
 * Validates message structure and types to prevent type confusion attacks.
 * All validation functions return { valid: boolean, error?: string }
 */

/**
 * Check if value is a string
 */
function isString(val) {
  return typeof val === "string";
}

/**
 * Check if value is a positive integer
 */
function isPositiveInteger(val) {
  return Number.isInteger(val) && val > 0;
}

/**
 * Check if value is an object (not null, not array)
 */
function isObject(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/**
 * Validate 'attach' message
 * { type: "attach", session?: string, cols: number, rows: number }
 */
export function validateAttach(msg) {
  if (!isObject(msg)) {
    return { valid: false, error: "Message must be an object" };
  }

  if (msg.type !== "attach") {
    return { valid: false, error: "Invalid type" };
  }

  // session is optional, but if provided must be a string
  if (msg.session !== undefined && !isString(msg.session)) {
    return { valid: false, error: "session must be a string" };
  }

  if (!isPositiveInteger(msg.cols)) {
    return { valid: false, error: "cols must be a positive integer" };
  }

  if (!isPositiveInteger(msg.rows)) {
    return { valid: false, error: "rows must be a positive integer" };
  }

  // Sanity check: reasonable terminal dimensions
  if (msg.cols > 1000 || msg.rows > 1000) {
    return { valid: false, error: "cols and rows must be <= 1000" };
  }

  return { valid: true };
}

/**
 * Validate 'input' message
 * { type: "input", data: string }
 */
export function validateInput(msg) {
  if (!isObject(msg)) {
    return { valid: false, error: "Message must be an object" };
  }

  if (msg.type !== "input") {
    return { valid: false, error: "Invalid type" };
  }

  if (!isString(msg.data)) {
    return { valid: false, error: "data must be a string" };
  }

  return { valid: true };
}

/**
 * Validate 'resize' message
 * { type: "resize", cols: number, rows: number }
 */
export function validateResize(msg) {
  if (!isObject(msg)) {
    return { valid: false, error: "Message must be an object" };
  }

  if (msg.type !== "resize") {
    return { valid: false, error: "Invalid type" };
  }

  if (!isPositiveInteger(msg.cols)) {
    return { valid: false, error: "cols must be a positive integer" };
  }

  if (!isPositiveInteger(msg.rows)) {
    return { valid: false, error: "rows must be a positive integer" };
  }

  // Sanity check: reasonable terminal dimensions
  if (msg.cols > 1000 || msg.rows > 1000) {
    return { valid: false, error: "cols and rows must be <= 1000" };
  }

  return { valid: true };
}

/**
 * Validate 'p2p-signal' message
 * { type: "p2p-signal", data: object }
 */
export function validateP2PSignal(msg) {
  if (!isObject(msg)) {
    return { valid: false, error: "Message must be an object" };
  }

  if (msg.type !== "p2p-signal") {
    return { valid: false, error: "Invalid type" };
  }

  if (!isObject(msg.data)) {
    return { valid: false, error: "data must be an object" };
  }

  return { valid: true };
}

/**
 * Validate any WebSocket message
 * Routes to specific validator based on type
 */
export function validateMessage(msg) {
  if (!isObject(msg)) {
    return { valid: false, error: "Message must be an object" };
  }

  if (!isString(msg.type)) {
    return { valid: false, error: "type must be a string" };
  }

  switch (msg.type) {
    case "attach":
      return validateAttach(msg);
    case "input":
      return validateInput(msg);
    case "resize":
      return validateResize(msg);
    case "p2p-signal":
      return validateP2PSignal(msg);
    default:
      return { valid: false, error: `Unknown message type: ${msg.type}` };
  }
}
