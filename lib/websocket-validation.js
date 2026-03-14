/**
 * WebSocket message validation
 *
 * Schema-driven validation of message structure and types to prevent
 * type confusion attacks. All validation functions return { valid: boolean, error?: string }
 */

function isString(val) { return typeof val === "string"; }
function isPositiveInteger(val) { return Number.isInteger(val) && val > 0; }
function isObject(val) { return val !== null && typeof val === "object" && !Array.isArray(val); }

// --- Field validators ---

function validateDimensions(msg) {
  if (!isPositiveInteger(msg.cols)) return { valid: false, error: "cols must be a positive integer" };
  if (!isPositiveInteger(msg.rows)) return { valid: false, error: "rows must be a positive integer" };
  if (msg.cols > 1000 || msg.rows > 1000) return { valid: false, error: "cols and rows must be <= 1000" };
  return { valid: true };
}

function validateSessionField(msg, required) {
  if (required) {
    if (!isString(msg.session)) return { valid: false, error: "session must be a string" };
  } else {
    if (msg.session !== undefined && !isString(msg.session)) return { valid: false, error: "session must be a string" };
  }
  return { valid: true };
}

function validateP2PData(msg) {
  if (!isObject(msg.data)) return { valid: false, error: "data must be an object" };
  if (msg.data.type !== undefined && !isString(msg.data.type)) return { valid: false, error: "data.type must be a string" };
  if (msg.data.sdp !== undefined && !isString(msg.data.sdp)) return { valid: false, error: "data.sdp must be a string" };
  if (msg.data.candidate !== undefined) {
    if (!isObject(msg.data.candidate)) return { valid: false, error: "data.candidate must be an object" };
    if (msg.data.candidate.candidate !== undefined && !isString(msg.data.candidate.candidate)) {
      return { valid: false, error: "data.candidate.candidate must be a string" };
    }
  }
  return { valid: true };
}

// --- Message schemas ---
// Each schema defines an array of field validator functions to run in order.

const messageSchemas = {
  attach: [
    (msg) => validateSessionField(msg, false),
    validateDimensions,
  ],
  switch: [
    (msg) => validateSessionField(msg, true),
    validateDimensions,
  ],
  input: [
    (msg) => isString(msg.data) ? { valid: true } : { valid: false, error: "data must be a string" },
  ],
  resize: [
    validateDimensions,
  ],
  "p2p-signal": [
    validateP2PData,
  ],
  "claude-input": [
    (msg) => validateSessionField(msg, true),
    (msg) => isString(msg.content) ? { valid: true } : { valid: false, error: "content must be a string" },
  ],
  "claude-tool-response": [
    (msg) => validateSessionField(msg, true),
    (msg) => isString(msg.id) ? { valid: true } : { valid: false, error: "id must be a string" },
    (msg) => typeof msg.approved === "boolean" ? { valid: true } : { valid: false, error: "approved must be a boolean" },
  ],
  "claude-abort": [
    (msg) => validateSessionField(msg, true),
  ],
};

// --- Core validation function ---

function validateBySchema(msg, expectedType) {
  if (!isObject(msg)) return { valid: false, error: "Message must be an object" };
  if (msg.type !== expectedType) return { valid: false, error: "Invalid type" };

  const validators = messageSchemas[expectedType];
  for (const validate of validators) {
    const result = validate(msg);
    if (!result.valid) return result;
  }
  return { valid: true };
}

// --- Exported per-type validators (backward compatible) ---

export function validateAttach(msg) { return validateBySchema(msg, "attach"); }
export function validateSwitch(msg) { return validateBySchema(msg, "switch"); }
export function validateInput(msg) { return validateBySchema(msg, "input"); }
export function validateResize(msg) { return validateBySchema(msg, "resize"); }
export function validateP2PSignal(msg) { return validateBySchema(msg, "p2p-signal"); }

/**
 * Validate any WebSocket message — routes to the schema for msg.type.
 */
export function validateMessage(msg) {
  if (!isObject(msg)) return { valid: false, error: "Message must be an object" };
  if (!isString(msg.type)) return { valid: false, error: "type must be a string" };
  if (!messageSchemas[msg.type]) return { valid: false, error: `Unknown message type: ${msg.type}` };
  return validateBySchema(msg, msg.type);
}
