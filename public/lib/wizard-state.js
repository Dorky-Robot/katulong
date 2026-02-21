/**
 * Device Pairing Wizard State Management
 *
 * Formal state machine for the device pairing wizard to prevent UI getting stuck.
 * Centralizes all wizard state transitions, timer management, and error handling.
 */

import { createStore, createReducer } from '/lib/store.js';

/**
 * Wizard state machine states
 */
export const WIZARD_STATES = {
  IDLE: 'idle',           // Wizard not active
  PAIRING: 'pairing',     // Step 1: Show QR + PIN for pairing
  SUCCESS: 'success',     // Step 2: Pairing completed
  ERROR: 'error'          // Error state with message
};

/**
 * Wizard action types
 */
export const WIZARD_ACTIONS = {
  START_PAIRING: 'wizard/start-pairing',
  UPDATE_CODE: 'wizard/update-code',
  PAIRING_SUCCESS: 'wizard/pairing-success',
  PAIRING_ERROR: 'wizard/pairing-error',
  RESET: 'wizard/reset',
  SET_TIMER: 'wizard/set-timer',
  CLEAR_TIMERS: 'wizard/clear-timers'
};

/**
 * Initial wizard state
 */
const initialState = {
  currentState: WIZARD_STATES.IDLE,
  pairCode: null,
  pairPin: null,
  pairUrl: null,
  expiresAt: null,
  errorMessage: null,
  timers: {
    refresh: null,
    countdown: null,
    statusPoll: null
  }
};

/**
 * Wizard state reducer
 */
const wizardReducer = createReducer(initialState, {
  [WIZARD_ACTIONS.START_PAIRING]: (state, action) => ({
    ...state,
    currentState: WIZARD_STATES.PAIRING,
    pairCode: action.code,
    pairPin: action.pin,
    pairUrl: action.url,
    expiresAt: action.expiresAt,
    errorMessage: null
  }),

  [WIZARD_ACTIONS.UPDATE_CODE]: (state, action) => ({
    ...state,
    pairCode: action.code,
    pairPin: action.pin,
    pairUrl: action.url,
    expiresAt: action.expiresAt,
    errorMessage: null
  }),

  [WIZARD_ACTIONS.PAIRING_SUCCESS]: (state) => ({
    ...state,
    currentState: WIZARD_STATES.SUCCESS
  }),

  [WIZARD_ACTIONS.PAIRING_ERROR]: (state, action) => ({
    ...state,
    currentState: WIZARD_STATES.ERROR,
    errorMessage: action.error
  }),

  [WIZARD_ACTIONS.SET_TIMER]: (state, action) => ({
    ...state,
    timers: {
      ...state.timers,
      [action.timerName]: action.timerId
    }
  }),

  [WIZARD_ACTIONS.CLEAR_TIMERS]: (state) => ({
    ...state,
    timers: {
      refresh: null,
      countdown: null,
      statusPoll: null
    }
  }),

  [WIZARD_ACTIONS.RESET]: () => initialState
});

/**
 * Create a wizard store instance
 * @returns {object} Store with getState, dispatch, subscribe
 */
export function createWizardStore() {
  return createStore(initialState, wizardReducer, { debug: true });
}
