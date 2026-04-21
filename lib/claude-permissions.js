/**
 * Claude permission-request store.
 *
 * Bridges Claude Code's in-terminal permission prompt ("Do you want to
 * proceed? 1. Yes  2. Yes, and always …  3. No") with the feed tile's
 * menu card. The flow:
 *
 *   1. Claude is about to call a gated tool. Claude Code fires a
 *      `PreToolUse` hook; `parsePreToolUsePayload` pulls out
 *      `{ uuid, pane, tool }`.
 *   2. The `/api/claude-events` handler schedules a short poll of the
 *      pane via `claude-pane-scanner.pollForPermissionPrompt`. If the
 *      "Do you want to proceed?" menu appears on screen, the handler
 *      calls `store.add(...)` to mint a `requestId` and publishes a
 *      `permission-request` envelope on the `claude/<uuid>` topic.
 *      Auto-approved tools never render the menu, so the poll just
 *      ages out with no publish.
 *   3. The feed tile renders four buttons. Clicking one hits
 *      `POST /api/claude/permission` with `{ requestId, choice }`.
 *   4. The route resolves the request from the store, finds the
 *      katulong-managed session whose `meta.claude.uuid` matches, sends
 *      the digit keystroke into the pane via tmux send-keys, and
 *      publishes `permission-resolved` to dim the card.
 *   5. If the user answered in the TTY instead, `PostToolUse` fires;
 *      the handler calls `store.findByUuid(uuid)` + resolves them so
 *      the card dismisses without a keystroke.
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

    /**
     * Every pending request for a given Claude session uuid. The
     * PostToolUse auto-dismiss path uses this: once a tool has run,
     * any surviving permission card for that session is stale (user
     * must have answered in the TTY) and should be resolved.
     */
    findByUuid(uuid) {
      expire();
      if (!uuid) return [];
      const out = [];
      for (const req of requests.values()) {
        if (req.uuid === uuid) out.push(req);
      }
      return out;
    },

    /** Exposed for tests to assert on store state. */
    size() {
      return requests.size;
    },
  };
}

/**
 * Validate + normalize a `PreToolUse` hook payload for the pane-scan
 * pipeline. Returns `{ uuid, pane, tool }` (pane may be null) or null
 * if the payload is unusable.
 *
 * Why PreToolUse and not Notification? Claude Code's `Notification` hook
 * fires for idle nudges and some MCP elicitations, not for the plain
 * "Do you want to proceed?" menu that in-terminal tool calls trigger.
 * PreToolUse fires synchronously before every tool invocation — that's
 * our earliest signal that a prompt *might* be about to appear. The
 * actual detection ("is the prompt on screen?") is done by
 * claude-pane-scanner against the tmux pane contents.
 */
export function parsePreToolUsePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.hook_event_name !== "PreToolUse") return null;

  const uuid = typeof payload.session_id === "string" ? payload.session_id : null;
  if (!uuid) return null;

  const pane = typeof payload._tmuxPane === "string" && /^%\d+$/.test(payload._tmuxPane)
    ? payload._tmuxPane
    : null;

  const tool = typeof payload.tool_name === "string" && /^[\w.-]+$/.test(payload.tool_name)
    ? payload.tool_name
    : null;

  return { uuid, pane, tool };
}
