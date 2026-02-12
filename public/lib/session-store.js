/**
 * Session List State Management
 *
 * Centralizes session state and connection info.
 */

import { createStore, createReducer } from '/lib/store.js';

const SESSION_ACTIONS = {
  LOAD_START: 'sessions/load-start',
  LOAD_SUCCESS: 'sessions/load-success',
  LOAD_ERROR: 'sessions/load-error',
  INVALIDATE: 'sessions/invalidate'
};

const initialState = {
  sessions: [],
  sshInfo: { sshPort: 2222, sshHost: "localhost" },
  currentSession: null,
  loading: false,
  error: null,
  lastUpdated: null
};

const sessionReducer = createReducer(initialState, {
  [SESSION_ACTIONS.LOAD_START]: (state) => ({
    ...state,
    loading: true,
    error: null
  }),

  [SESSION_ACTIONS.LOAD_SUCCESS]: (state, action) => ({
    ...state,
    sessions: action.sessions,
    sshInfo: action.sshInfo || state.sshInfo,
    currentSession: action.currentSession,
    loading: false,
    error: null,
    lastUpdated: Date.now()
  }),

  [SESSION_ACTIONS.LOAD_ERROR]: (state, action) => ({
    ...state,
    loading: false,
    error: action.error
  }),

  [SESSION_ACTIONS.INVALIDATE]: (state) => ({
    ...state,
    lastUpdated: null
  })
});

/**
 * Create session store
 */
export function createSessionStore(currentSession) {
  const store = createStore(
    { ...initialState, currentSession },
    sessionReducer,
    { debug: false }
  );

  // Auto-load on creation
  loadSessions(store, currentSession);

  return store;
}

/**
 * Load sessions from API
 */
export async function loadSessions(store, currentSession = null) {
  store.dispatch({ type: SESSION_ACTIONS.LOAD_START });

  try {
    const [sessRes, infoRes] = await Promise.all([
      fetch("/sessions"),
      fetch("/connect/info")
    ]);

    const sessions = await sessRes.json();
    let sshInfo = store.getState().sshInfo;

    if (infoRes.ok) {
      const info = await infoRes.json();
      sshInfo = { ...sshInfo, ...info };
    }

    store.dispatch({
      type: SESSION_ACTIONS.LOAD_SUCCESS,
      sessions,
      sshInfo,
      currentSession: currentSession || store.getState().currentSession
    });
  } catch (err) {
    store.dispatch({
      type: SESSION_ACTIONS.LOAD_ERROR,
      error: err.message
    });
    console.error("Failed to load sessions:", err);
  }
}

/**
 * Invalidate and reload sessions
 */
export function invalidateSessions(store, currentSession = null) {
  store.dispatch({ type: SESSION_ACTIONS.INVALIDATE });
  loadSessions(store, currentSession);
}

export { SESSION_ACTIONS };
