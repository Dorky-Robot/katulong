/**
 * Device List State Management
 *
 * Centralizes device state to eliminate manual loadDevices() calls.
 * Devices auto-refresh when:
 * - Device renamed/removed
 * - Page loads
 */

import { createStore, createReducer } from '/lib/store.js';

const DEVICE_ACTIONS = {
  LOAD_START: 'devices/load-start',
  LOAD_SUCCESS: 'devices/load-success',
  LOAD_ERROR: 'devices/load-error',
  INVALIDATE: 'devices/invalidate'
};

const initialState = {
  devices: [],
  currentCredentialId: null,
  loading: false,
  error: null,
  lastUpdated: null
};

const deviceReducer = createReducer(initialState, {
  [DEVICE_ACTIONS.LOAD_START]: (state) => ({
    ...state,
    loading: true,
    error: null
  }),

  [DEVICE_ACTIONS.LOAD_SUCCESS]: (state, action) => ({
    ...state,
    devices: action.devices,
    currentCredentialId: action.currentCredentialId,
    loading: false,
    error: null,
    lastUpdated: Date.now()
  }),

  [DEVICE_ACTIONS.LOAD_ERROR]: (state, action) => ({
    ...state,
    loading: false,
    error: action.error,
    devices: [] // Clear on error
  }),

  [DEVICE_ACTIONS.INVALIDATE]: (state) => ({
    ...state,
    lastUpdated: null // Mark as stale
  })
});

/**
 * Create device store with auto-refresh logic
 */
export function createDeviceStore() {
  const store = createStore(initialState, deviceReducer, { debug: false });

  // Auto-load devices on store creation
  loadDevices(store);

  return store;
}

/**
 * Load devices from API
 */
export async function loadDevices(store) {
  store.dispatch({ type: DEVICE_ACTIONS.LOAD_START });

  try {
    const res = await fetch("/auth/devices");
    if (!res.ok) throw new Error("Failed to load devices");

    const { devices, currentCredentialId } = await res.json();

    store.dispatch({
      type: DEVICE_ACTIONS.LOAD_SUCCESS,
      devices,
      currentCredentialId
    });
  } catch (err) {
    store.dispatch({
      type: DEVICE_ACTIONS.LOAD_ERROR,
      error: err.message
    });
    console.error("Failed to load devices:", err);
  }
}

/**
 * Invalidate device cache (triggers re-fetch on next render)
 */
export function invalidateDevices(store) {
  store.dispatch({ type: DEVICE_ACTIONS.INVALIDATE });
  // Immediately reload
  loadDevices(store);
}

export { DEVICE_ACTIONS };
