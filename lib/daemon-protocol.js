/**
 * Daemon message protocol definitions.
 *
 * Shared between daemon.js and daemon-client.js to ensure
 * consistent message types and shapes.
 */

/**
 * RPC types — require an `id` field and return a response.
 * Note: "detach" also works as fire-and-forget (without `id`).
 */
export const RPC_TYPES = new Set([
  "list-sessions",
  "create-session",
  "delete-session",
  "rename-session",
  "attach",
  "detach",
  "get-shortcuts",
  "set-shortcuts",
]);

/** Fire-and-forget types — no `id`, no response */
export const FIRE_AND_FORGET_TYPES = new Set([
  "input",
  "resize",
  "detach",
]);

/** Broadcast types — daemon sends to all connected UI sockets */
export const BROADCAST_TYPES = new Set([
  "output",
  "exit",
  "session-removed",
  "session-renamed",
  "child-count-update",
]);

/** All valid message types (union of all sets) */
export const ALL_TYPES = new Set([
  ...RPC_TYPES,
  ...FIRE_AND_FORGET_TYPES,
  ...BROADCAST_TYPES,
]);

/**
 * Required fields per message type (beyond `type` and optional `id`).
 */
const REQUIRED_FIELDS = {
  "create-session": ["name"],
  "delete-session": ["name"],
  "rename-session": ["oldName", "newName"],
  "attach": ["clientId"],
  "input": ["clientId", "data"],
  "resize": ["clientId", "cols", "rows"],
  "detach": ["clientId"],
  "set-shortcuts": ["data"],
  "output": ["session", "data"],
  "exit": ["session", "code"],
  "session-removed": ["session"],
  "session-renamed": ["session", "newName"],
  "child-count-update": ["session", "count"],
};

/**
 * Validate a daemon protocol message.
 *
 * @param {*} msg - Message to validate
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return { valid: false, error: "Message must be a non-null object" };
  }

  if (typeof msg.type !== "string") {
    return { valid: false, error: "Message must have a string 'type' field" };
  }

  if (!ALL_TYPES.has(msg.type)) {
    return { valid: false, error: `Unknown message type: ${msg.type}` };
  }

  const required = REQUIRED_FIELDS[msg.type];
  if (required) {
    for (const field of required) {
      if (msg[field] === undefined) {
        return { valid: false, error: `Missing required field '${field}' for type '${msg.type}'` };
      }
    }
  }

  return { valid: true };
}
