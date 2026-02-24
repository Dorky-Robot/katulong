/**
 * Frontend Stores
 *
 * Consolidated state management for sessions, shortcuts, and tokens.
 * All three follow the same pattern: Redux-style reducer + API sync.
 */

import { createStore, createReducer } from '/lib/store.js';
import { api } from '/lib/api-client.js';

// ============================================================
// Session Store
// ============================================================

const SESSION_ACTIONS = {
  LOAD_START: 'sessions/load-start',
  LOAD_SUCCESS: 'sessions/load-success',
  LOAD_ERROR: 'sessions/load-error',
  INVALIDATE: 'sessions/invalidate'
};

const sessionInitialState = {
  sessions: [],
  sshInfo: { sshPort: 2222, sshHost: "localhost" },
  currentSession: null,
  loading: false,
  error: null,
  lastUpdated: null
};

const sessionReducer = createReducer(sessionInitialState, {
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

export function createSessionStore(currentSession) {
  const store = createStore(
    { ...sessionInitialState, currentSession },
    sessionReducer,
    { debug: false }
  );
  loadSessions(store, currentSession);
  return store;
}

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

export function invalidateSessions(store, currentSession = null) {
  store.dispatch({ type: SESSION_ACTIONS.INVALIDATE });
  loadSessions(store, currentSession);
}

// ============================================================
// Shortcuts Store
// ============================================================

const SHORTCUTS_ACTIONS = {
  LOAD: 'shortcuts/load',
  ADD: 'shortcuts/add',
  REMOVE: 'shortcuts/remove'
};

const shortcutsReducer = createReducer([], {
  [SHORTCUTS_ACTIONS.LOAD]: (shortcuts, action) => {
    return Array.isArray(action.items) ? action.items.filter(s => s.label && s.keys) : [];
  },
  [SHORTCUTS_ACTIONS.ADD]: (shortcuts, action) => {
    return [...shortcuts, action.item];
  },
  [SHORTCUTS_ACTIONS.REMOVE]: (shortcuts, action) => {
    return shortcuts.filter((_, idx) => idx !== action.index);
  }
});

export function createShortcutsStore() {
  const store = createStore([], shortcutsReducer, { debug: false });
  loadShortcuts(store);
  return store;
}

export async function loadShortcuts(store) {
  try {
    const data = await api.get("/shortcuts");
    store.dispatch({ type: SHORTCUTS_ACTIONS.LOAD, items: data });
  } catch {
    store.dispatch({ type: SHORTCUTS_ACTIONS.LOAD, items: [] });
  }
}

export async function saveShortcuts(shortcuts) {
  try {
    await api.put("/shortcuts", shortcuts);
  } catch {
    console.error('[Shortcuts] Failed to save');
  }
}

export function addShortcut(store, item) {
  store.dispatch({ type: SHORTCUTS_ACTIONS.ADD, item });
  saveShortcuts(store.getState());
}

export function removeShortcut(store, index) {
  store.dispatch({ type: SHORTCUTS_ACTIONS.REMOVE, index });
  saveShortcuts(store.getState());
}

// ============================================================
// Token Store
// ============================================================

const TOKEN_ACTIONS = {
  LOAD_START: 'tokens/load-start',
  LOAD_SUCCESS: 'tokens/load-success',
  LOAD_ERROR: 'tokens/load-error',
  SET_NEW_TOKEN: 'tokens/set-new-token',
  CLEAR_NEW_TOKEN: 'tokens/clear-new-token',
  INVALIDATE: 'tokens/invalidate'
};

const tokenInitialState = {
  tokens: [],
  newToken: null,
  loading: false,
  error: null,
  lastUpdated: null
};

const tokenReducer = createReducer(tokenInitialState, {
  [TOKEN_ACTIONS.LOAD_START]: (state) => ({
    ...state,
    loading: true,
    error: null
  }),

  [TOKEN_ACTIONS.LOAD_SUCCESS]: (state, action) => ({
    ...state,
    tokens: action.tokens,
    loading: false,
    error: null,
    lastUpdated: Date.now()
  }),

  [TOKEN_ACTIONS.LOAD_ERROR]: (state, action) => ({
    ...state,
    loading: false,
    error: action.error
  }),

  [TOKEN_ACTIONS.SET_NEW_TOKEN]: (state, action) => ({
    ...state,
    newToken: action.token
  }),

  [TOKEN_ACTIONS.CLEAR_NEW_TOKEN]: (state) => ({
    ...state,
    newToken: null
  }),

  [TOKEN_ACTIONS.INVALIDATE]: (state) => ({
    ...state,
    lastUpdated: null
  })
});

export function createTokenStore() {
  const store = createStore(tokenInitialState, tokenReducer, { debug: true });
  loadTokens(store);
  return store;
}

export async function loadTokens(store) {
  store.dispatch({ type: TOKEN_ACTIONS.LOAD_START });

  try {
    const [tokensRes, credsRes] = await Promise.all([
      fetch("/api/tokens"),
      fetch("/api/credentials"),
    ]);
    if (!tokensRes.ok) throw new Error("Failed to load tokens");
    const { tokens } = await tokensRes.json();

    if (credsRes.ok) {
      const { credentials } = await credsRes.json();
      const linkedCredIds = new Set(
        tokens.filter(t => t.credential).map(t => t.credential.id)
      );
      for (const cred of credentials) {
        if (!linkedCredIds.has(cred.id)) {
          tokens.push({
            id: null,
            name: cred.name,
            createdAt: cred.createdAt,
            lastUsedAt: cred.lastUsedAt,
            credential: {
              id: cred.id,
              name: cred.name,
              createdAt: cred.createdAt,
              lastUsedAt: cred.lastUsedAt,
              userAgent: cred.userAgent,
            },
            _orphanedCredential: true,
          });
        }
      }
    }

    store.dispatch({
      type: TOKEN_ACTIONS.LOAD_SUCCESS,
      tokens
    });
  } catch (err) {
    store.dispatch({
      type: TOKEN_ACTIONS.LOAD_ERROR,
      error: err.message
    });
    console.error("Failed to load tokens:", err);
  }
}

export function setNewToken(store, tokenData) {
  store.dispatch({
    type: TOKEN_ACTIONS.SET_NEW_TOKEN,
    token: tokenData
  });
  const currentState = store.getState();
  store.dispatch({
    type: TOKEN_ACTIONS.LOAD_SUCCESS,
    tokens: [
      ...currentState.tokens,
      { id: tokenData.id, name: tokenData.name, createdAt: tokenData.createdAt, credential: null }
    ]
  });
}

export function clearNewToken(store) {
  store.dispatch({ type: TOKEN_ACTIONS.CLEAR_NEW_TOKEN });
  loadTokens(store);
}

export function invalidateTokens(store) {
  store.dispatch({ type: TOKEN_ACTIONS.INVALIDATE });
  loadTokens(store);
}

export function removeToken(store, tokenId) {
  const currentState = store.getState();
  store.dispatch({
    type: TOKEN_ACTIONS.LOAD_SUCCESS,
    tokens: currentState.tokens.filter(t => t.id !== tokenId)
  });
}

export { SESSION_ACTIONS, SHORTCUTS_ACTIONS, TOKEN_ACTIONS };
