/**
 * Token State Management
 *
 * Centralizes token list state and new token display.
 */

import { createStore, createReducer } from '/lib/store.js';

const TOKEN_ACTIONS = {
  LOAD_START: 'tokens/load-start',
  LOAD_SUCCESS: 'tokens/load-success',
  LOAD_ERROR: 'tokens/load-error',
  SET_NEW_TOKEN: 'tokens/set-new-token',
  CLEAR_NEW_TOKEN: 'tokens/clear-new-token',
  INVALIDATE: 'tokens/invalidate'
};

const initialState = {
  tokens: [],
  newToken: null, // { id, name, token } for newly created token display
  loading: false,
  error: null,
  lastUpdated: null
};

const tokenReducer = createReducer(initialState, {
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

/**
 * Create token store
 */
export function createTokenStore() {
  const store = createStore(initialState, tokenReducer, { debug: true });

  // Auto-load on creation
  loadTokens(store);

  return store;
}

/**
 * Load tokens from API
 */
export async function loadTokens(store) {
  store.dispatch({ type: TOKEN_ACTIONS.LOAD_START });

  try {
    const res = await fetch("/api/tokens");
    if (!res.ok) throw new Error("Failed to load tokens");
    const { tokens } = await res.json();

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

/**
 * Set newly created token for display
 */
export function setNewToken(store, tokenData) {
  store.dispatch({
    type: TOKEN_ACTIONS.SET_NEW_TOKEN,
    token: tokenData
  });
  // Immediately add to tokens list to avoid race condition with API
  const currentState = store.getState();
  store.dispatch({
    type: TOKEN_ACTIONS.LOAD_SUCCESS,
    tokens: [
      ...currentState.tokens,
      { id: tokenData.id, name: tokenData.name, createdAt: tokenData.createdAt, credential: null }
    ]
  });
}

/**
 * Clear new token display
 */
export function clearNewToken(store) {
  store.dispatch({ type: TOKEN_ACTIONS.CLEAR_NEW_TOKEN });
  loadTokens(store);
}

/**
 * Invalidate and reload tokens
 */
export function invalidateTokens(store) {
  store.dispatch({ type: TOKEN_ACTIONS.INVALIDATE });
  loadTokens(store);
}

export { TOKEN_ACTIONS };
