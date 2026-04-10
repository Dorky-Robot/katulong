/**
 * Heartbeat Machine
 *
 * Pure state machine for WebSocket heartbeat ping/pong.  ZERO imports —
 * takes state in, returns { state, effects } out.  The caller is responsible
 * for scheduling ticks, sending pings over the wire, and acting on effects.
 *
 * Effects:
 *   - { type: "sendPing" }  — caller should send a ping frame/message
 *   - { type: "timeout" }   — pong was not received in time; connection is dead
 *
 * The epoch counter prevents stale pong callbacks from old connections from
 * affecting new ones — same pattern as _writeId in pull-manager.js.
 */

export const INTERVAL_MS = 10000; // 10s between pings
export const TIMEOUT_MS = 8000;   // 8s timeout waiting for pong

/** Returns initial state. */
export function create() {
  return { status: "idle", sentAt: 0, epoch: 0 };
}

/**
 * Called on every new connection with a new epoch.
 * Resets to idle regardless of current state.
 */
export function reset(state, epoch) {
  return {
    state: { status: "idle", sentAt: 0, epoch },
    effects: [],
  };
}

/**
 * Transition from idle to waiting — emit a sendPing effect.
 * No-op if already waiting (idempotent).
 */
export function sendPing(state, now) {
  if (state.status !== "idle") {
    return { state, effects: [] };
  }
  return {
    state: { ...state, status: "waiting", sentAt: now },
    effects: [{ type: "sendPing" }],
  };
}

/**
 * Process an incoming pong.
 * Stale-callback guard: if epoch doesn't match, the pong is from an old
 * connection and is silently ignored.
 */
export function receivePong(state, epoch) {
  if (epoch !== state.epoch) {
    return { state, effects: [] };
  }
  if (state.status !== "waiting") {
    return { state, effects: [] };
  }
  return {
    state: { ...state, status: "idle", sentAt: 0 },
    effects: [],
  };
}

/**
 * Clock tick — check if a pending pong has timed out.
 * No-op if not waiting or if timeout hasn't elapsed yet.
 */
export function tick(state, now) {
  if (state.status !== "waiting") {
    return { state, effects: [] };
  }
  if (now - state.sentAt < TIMEOUT_MS) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, status: "idle", sentAt: 0 },
    effects: [{ type: "timeout" }],
  };
}
