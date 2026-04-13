/**
 * Reconciler Store — FSM state for the session reconciler.
 *
 * Replaces the mutable `reconcilePruneConfirmations`, `lastDeadKey`,
 * and `bootReconcileDone` variables in app.js. The reconciler compares
 * local tiles against the server session list and prunes dead sessions
 * after a confirmation threshold.
 *
 * State shape: {
 *   confirmations: number,   // consecutive reconciles with same dead set
 *   lastDeadKey: string,     // serialized dead set from previous pass
 *   bootDone: boolean,       // has boot reconcile completed?
 * }
 */

import { createStore } from "./store.js";

export const EMPTY_STATE = Object.freeze({
  confirmations: 0,
  lastDeadKey: "",
  bootDone: false,
});

// Action types
export const CONFIRM     = "reconciler/CONFIRM";
export const RESET       = "reconciler/RESET";
export const BOOT_DONE   = "reconciler/BOOT_DONE";

function reducer(state, action) {
  switch (action.type) {
    case CONFIRM: {
      // If dead set changed, reset counter and record new key
      if (action.deadKey !== state.lastDeadKey) {
        return { ...state, confirmations: 1, lastDeadKey: action.deadKey };
      }
      return { ...state, confirmations: state.confirmations + 1 };
    }
    case RESET:
      return { ...state, confirmations: 0, lastDeadKey: "" };
    case BOOT_DONE:
      if (state.bootDone) return state;
      return { ...state, bootDone: true };
    default:
      return state;
  }
}

export function createReconcilerStore() {
  const store = createStore(EMPTY_STATE, reducer);

  return {
    getState:  store.getState,
    dispatch:  store.dispatch,
    subscribe: store.subscribe,
    // Convenience
    confirm: (deadKey) => store.dispatch({ type: CONFIRM, deadKey }),
    reset: () => store.dispatch({ type: RESET }),
    markBootDone: () => store.dispatch({ type: BOOT_DONE }),
  };
}
