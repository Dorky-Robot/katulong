/**
 * Certificate State Management
 *
 * Centralizes certificate state for network certificates.
 * Auto-refreshes when certificates are generated/regenerated/revoked.
 */

import { createStore, createReducer } from './store.js';

const CERT_ACTIONS = {
  LOAD_START: 'certificates/load-start',
  LOAD_SUCCESS: 'certificates/load-success',
  LOAD_ERROR: 'certificates/load-error',
  SET_CONFIRM_STATE: 'certificates/set-confirm-state',
  CLEAR_CONFIRM_STATE: 'certificates/clear-confirm-state',
  CLEAR_ALL_CONFIRM: 'certificates/clear-all-confirm'
};

const initialState = {
  networks: [],
  currentNetwork: null,
  loading: false,
  error: null,
  lastUpdated: null,
  confirmState: {} // Track which buttons are in confirm mode
};

const certificateReducer = createReducer(initialState, {
  [CERT_ACTIONS.LOAD_START]: (state) => ({
    ...state,
    loading: true,
    error: null
  }),

  [CERT_ACTIONS.LOAD_SUCCESS]: (state, action) => ({
    ...state,
    networks: action.networks,
    currentNetwork: action.currentNetwork,
    loading: false,
    error: null,
    lastUpdated: Date.now()
  }),

  [CERT_ACTIONS.LOAD_ERROR]: (state, action) => ({
    ...state,
    loading: false,
    error: action.error
  }),

  [CERT_ACTIONS.SET_CONFIRM_STATE]: (state, action) => ({
    ...state,
    confirmState: {
      ...state.confirmState,
      [action.key]: true
    }
  }),

  [CERT_ACTIONS.CLEAR_CONFIRM_STATE]: (state, action) => {
    const newConfirmState = { ...state.confirmState };
    delete newConfirmState[action.key];
    return {
      ...state,
      confirmState: newConfirmState
    };
  },

  [CERT_ACTIONS.CLEAR_ALL_CONFIRM]: (state) => ({
    ...state,
    confirmState: {}
  })
});

/**
 * Create certificate store
 */
export function createCertificateStore() {
  const store = createStore(initialState, certificateReducer, { debug: false });

  // Auto-load on creation
  loadCertificates(store);

  return store;
}

/**
 * Load certificates from API
 */
export async function loadCertificates(store) {
  console.log('[CertStore] Loading certificates...');
  store.dispatch({ type: CERT_ACTIONS.LOAD_START });

  try {
    const res = await fetch("/api/certificates/status");
    console.log('[CertStore] API response status:', res.status, res.ok);

    if (!res.ok) throw new Error("Failed to load certificates");

    const data = await res.json();
    console.log('[CertStore] Loaded data:', {
      networksCount: data.allNetworks?.length,
      currentNetwork: data.currentNetwork?.networkId
    });

    store.dispatch({
      type: CERT_ACTIONS.LOAD_SUCCESS,
      networks: data.allNetworks || [],
      currentNetwork: data.currentNetwork
    });
  } catch (err) {
    console.error('[CertStore] Load failed:', err);
    store.dispatch({
      type: CERT_ACTIONS.LOAD_ERROR,
      error: err.message
    });
  }
}

/**
 * Set confirm state for a button
 */
export function setConfirmState(store, key) {
  store.dispatch({
    type: CERT_ACTIONS.SET_CONFIRM_STATE,
    key
  });
}

/**
 * Clear confirm state for a button
 */
export function clearConfirmState(store, key) {
  store.dispatch({
    type: CERT_ACTIONS.CLEAR_CONFIRM_STATE,
    key
  });
}

/**
 * Clear all confirm states
 */
export function clearAllConfirmStates(store) {
  store.dispatch({ type: CERT_ACTIONS.CLEAR_ALL_CONFIRM });
}

/**
 * Regenerate network certificate
 */
export async function regenerateNetwork(store, networkId) {
  try {
    const res = await fetch(`/api/certificates/networks/${networkId}/regenerate`, {
      method: 'POST'
    });

    if (!res.ok) throw new Error("Failed to regenerate certificate");

    const data = await res.json();

    // Clear confirm state and reload
    clearConfirmState(store, `network-${networkId}`);
    await loadCertificates(store);

    return { success: true, message: data.message };
  } catch (err) {
    console.error("Failed to regenerate network:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Revoke network certificate
 */
export async function revokeNetwork(store, networkId) {
  try {
    const res = await fetch(`/api/certificates/networks/${networkId}`, {
      method: 'DELETE'
    });

    if (!res.ok) throw new Error("Failed to revoke certificate");

    // Clear confirm state and reload
    clearConfirmState(store, `revoke-${networkId}`);
    await loadCertificates(store);

    return { success: true };
  } catch (err) {
    console.error("Failed to revoke network:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Update network label
 */
export async function updateNetworkLabel(store, networkId, label) {
  try {
    const res = await fetch(`/api/certificates/networks/${networkId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label })
    });

    if (!res.ok) throw new Error("Failed to update label");

    await loadCertificates(store);
    return { success: true };
  } catch (err) {
    console.error("Failed to update label:", err);
    return { success: false, error: err.message };
  }
}

export { CERT_ACTIONS };
