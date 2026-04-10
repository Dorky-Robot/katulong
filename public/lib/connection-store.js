/**
 * Connection Store — single source of truth for WebSocket/DataChannel
 * connection status.
 *
 * Replaces scattered connection state (booleans, string flags across
 * multiple modules) with a reducer-driven state machine. Only valid
 * transitions are accepted; invalid dispatches are silent no-ops.
 *
 * State machine:
 *
 *   disconnected ──CONNECTING──▶ connecting ──READY──▶ ready
 *        ▲                            │                  │ │
 *        │         DISCONNECTED       │  DISCONNECTED    │ │
 *        └────────────────────────────┘                  │ │
 *        └───────────────────────────────────────────────┘ │
 *                                     TRANSPORT_CHANGED    │
 *                                          (self-loop) ◀───┘
 *
 * Invariants:
 *   - status === "disconnected" ⟹ transport === null
 *   - status === "ready"        ⟹ transport ∈ {"websocket", "datachannel"}
 */

import { createStore } from "./store.js";

// ─── Constants ──────────────────────────────────────────────────────
const VALID_TRANSPORTS = new Set(["websocket", "datachannel"]);

export const EMPTY_STATE = Object.freeze({
  status: "disconnected",
  transport: null,
});

// ─── Action types ───────────────────────────────────────────────────
export const CONNECTING        = "conn/CONNECTING";
export const READY             = "conn/READY";
export const TRANSPORT_CHANGED = "conn/TRANSPORT_CHANGED";
export const DISCONNECTED      = "conn/DISCONNECTED";

// ─── Reducer ────────────────────────────────────────────────────────
export function reducer(state = EMPTY_STATE, action) {
  switch (action.type) {
    case CONNECTING: {
      if (state.status !== "disconnected") return state;
      return { status: "connecting", transport: null };
    }

    case READY: {
      if (state.status !== "connecting") return state;
      if (!VALID_TRANSPORTS.has(action.transport)) return state;
      return { status: "ready", transport: action.transport };
    }

    case TRANSPORT_CHANGED: {
      if (state.status !== "ready") return state;
      if (!VALID_TRANSPORTS.has(action.transport)) return state;
      return { status: "ready", transport: action.transport };
    }

    case DISCONNECTED: {
      if (state.status === "disconnected") return state;
      return { status: "disconnected", transport: null };
    }

    default:
      return state;
  }
}

// ─── Store factory ──────────────────────────────────────────────────
export function createConnectionStore({ debug = false } = {}) {
  const store = createStore(EMPTY_STATE, reducer, { debug });

  return {
    getState:         store.getState,
    subscribe:        store.subscribe,
    dispatch:         store.dispatch,
    // Convenience action creators
    connecting:       () => store.dispatch({ type: CONNECTING }),
    ready:            (transport) => store.dispatch({ type: READY, transport }),
    transportChanged: (transport) => store.dispatch({ type: TRANSPORT_CHANGED, transport }),
    disconnected:     () => store.dispatch({ type: DISCONNECTED }),
  };
}
