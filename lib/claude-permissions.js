/**
 * Claude permission-request store.
 *
 * Bridges Claude Code's `Notification` hook (fired when Claude wants user
 * consent to run a tool) with the feed tile's menu card. The flow:
 *
 *   1. Claude hits a gated tool. Claude Code fires a `Notification` hook
 *      payload with `hook_event_name: "Notification"` + a human message
 *      like "Claude needs your permission to use Bash".
 *   2. The `/api/claude-events` handler calls `parseNotificationPayload`
 *      to decide whether it's a permission prompt (vs idle). If so it
 *      calls `store.add(...)` to mint a `requestId` and publishes a
 *      `permission-request` envelope on the `claude/<uuid>` topic.
 *   3. The feed tile renders three buttons. Clicking one hits
 *      `POST /api/claude/permission` with `{ requestId, choice }`.
 *   4. The route resolves the request from the store, finds the
 *      katulong-managed session whose `meta.claude.uuid` matches, sends
 *      the digit keystroke into the pane via tmux send-keys, and
 *      publishes `permission-resolved` to dim the card.
 *
 * The store is purely in-memory — permission prompts are ephemeral
 * (answered in seconds or they rot) and nothing about them deserves to
 * survive a server restart. Each entry expires after `ttlMs` so a
 * prompt that was already answered in the TTY doesn't linger forever.
 */

import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Mint a 128-bit random request id. URL-safe hex is fine — clients just
 * pass it back on the resolve POST, they don't parse the shape.
 */
function defaultGenId() {
  return randomBytes(16).toString("hex");
}

/**
 * Create an in-memory permission store.
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=300000] - How long a request lives before
 *   expiration. Matches Claude's own UI timeout loosely; past this point
 *   the user probably answered in the TTY and the card is stale.
 * @param {() => number} [opts.now] - Injectable clock for tests.
 * @param {() => string} [opts.genId] - Injectable id generator for tests.
 */
export function createPermissionStore({
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  genId = defaultGenId,
} = {}) {
  const requests = new Map();

  function expire() {
    const cutoff = now() - ttlMs;
    for (const [id, req] of requests) {
      if (req.createdAt < cutoff) requests.delete(id);
    }
  }

  return {
    /**
     * Record a pending permission request. Returns the stored record
     * (includes `requestId` + `createdAt`) so the caller can publish
     * it straight to the topic.
     */
    add(fields) {
      expire();
      const requestId = genId();
      const record = { ...fields, requestId, createdAt: now() };
      requests.set(requestId, record);
      return record;
    },

    /**
     * Look up a request without removing it. Returns null if unknown
     * or already expired.
     */
    get(requestId) {
      expire();
      return requests.get(requestId) ?? null;
    },

    /**
     * Pop a request. Returns the record (and removes it) or null if
     * unknown / expired. The feed resolve handler calls this so a
     * double-click can't dispatch two tmux writes.
     */
    resolve(requestId) {
      expire();
      const record = requests.get(requestId);
      if (!record) return null;
      requests.delete(requestId);
      return record;
    },

    /**
     * Read current pending requests. Used by tests.
     */
    list() {
      expire();
      return [...requests.values()];
    },

    /** Exposed for tests to assert on store state. */
    size() {
      return requests.size;
    },
  };
}

/**
 * Decide whether a Claude hook payload describes a permission prompt
 * we should surface as a menu card. Returns the pre-normalized fields
 * the store wants, or null if the payload is not a permission prompt.
 *
 * Claude Code's `Notification` hook fires in two flavors:
 *   - `permission_prompt` — Claude wants consent to run a tool
 *   - `idle_prompt`       — Claude has been quiet for a while
 *
 * The matcher comes through as `message_type` or is inferable from the
 * message text ("Claude needs your permission to use ..."). We also
 * accept the top-level `matcher` field for forward-compat with hook
 * payload shape changes.
 */
export function parseNotificationPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.hook_event_name !== "Notification") return null;

  const uuid = typeof payload.session_id === "string" ? payload.session_id : null;
  if (!uuid) return null;

  const message = typeof payload.message === "string" ? payload.message : "";
  const matcher = typeof payload.matcher === "string" ? payload.matcher
    : typeof payload.message_type === "string" ? payload.message_type
    : null;

  // Look for anything that unambiguously identifies a permission prompt.
  // If neither the matcher nor the message suggests it, fall through —
  // an idle-prompt notification has no actionable menu to render.
  const isPermissionPrompt =
    matcher === "permission_prompt" ||
    /permission to use/i.test(message) ||
    /needs your permission/i.test(message);
  if (!isPermissionPrompt) return null;

  const tool = extractToolFromMessage(message);
  const pane = typeof payload._tmuxPane === "string" && /^%\d+$/.test(payload._tmuxPane)
    ? payload._tmuxPane
    : null;

  return { uuid, message, tool, pane };
}

/**
 * Pull the tool name out of a permission-prompt message. The canonical
 * shape is "Claude needs your permission to use <ToolName>". Returns
 * null when the pattern doesn't match so the feed card falls back to
 * showing the full message.
 */
function extractToolFromMessage(message) {
  if (!message) return null;
  const m = message.match(/permission to use\s+(\w[\w.-]*)/i);
  return m ? m[1] : null;
}
