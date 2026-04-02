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
    (msg) => validateSessionField(msg, false),
  ],
  resize: [
    validateDimensions,
    (msg) => validateSessionField(msg, false),
  ],
  "helm-input": [
    (msg) => validateSessionField(msg, true),
    (msg) => isString(msg.content) ? { valid: true } : { valid: false, error: "content must be a string" },
  ],
  "helm-tool-response": [
    (msg) => validateSessionField(msg, true),
    (msg) => isString(msg.id) ? { valid: true } : { valid: false, error: "id must be a string" },
    (msg) => typeof msg.approved === "boolean" ? { valid: true } : { valid: false, error: "approved must be a boolean" },
  ],
  "helm-abort": [
    (msg) => validateSessionField(msg, true),
  ],
  pull: [
    (msg) => validateSessionField(msg, false),
    (msg) => Number.isInteger(msg.fromSeq) && msg.fromSeq >= 0
      ? { valid: true } : { valid: false, error: "fromSeq must be a non-negative integer" },
  ],
  subscribe: [
    (msg) => validateSessionField(msg, true),
  ],
  unsubscribe: [
    (msg) => validateSessionField(msg, true),
  ],
  resync: [
    (msg) => validateSessionField(msg, true),
  ],
  "set-tab-icon": [
    (msg) => validateSessionField(msg, true),
    (msg) => {
      if (msg.icon !== null && msg.icon !== undefined && !isString(msg.icon)) {
        return { valid: false, error: "icon must be a string or null" };
      }
      if (isString(msg.icon) && msg.icon.length > 50) {
        return { valid: false, error: "icon must be <= 50 characters" };
      }
      return { valid: true };
    },
  ],
  "device-auth-approve": [
    (msg) => isString(msg.requestId) ? { valid: true } : { valid: false, error: "requestId required" },
  ],
  "device-auth-deny": [
    (msg) => isString(msg.requestId) ? { valid: true } : { valid: false, error: "requestId required" },
  ],
  // WebRTC signaling
  "rtc-offer": [
    (msg) => isString(msg.sdp) ? { valid: true } : { valid: false, error: "sdp must be a string" },
  ],
  "rtc-ice-candidate": [
    (msg) => isObject(msg.candidate) ? { valid: true } : { valid: false, error: "candidate must be an object" },
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

/**
 * Validate any WebSocket message — routes to the schema for msg.type.
 */
export function validateMessage(msg) {
  if (!isObject(msg)) return { valid: false, error: "Message must be an object" };
  if (!isString(msg.type)) return { valid: false, error: "type must be a string" };
  // Allow namespaced plugin message types (e.g. "tala:subscribe") through
  if (msg.type.includes(":")) return { valid: true };
  if (!messageSchemas[msg.type]) return { valid: false, error: `Unknown message type: ${msg.type}` };
  return validateBySchema(msg, msg.type);
}
