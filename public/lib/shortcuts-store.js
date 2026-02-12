/**
 * Shortcuts State Management
 *
 * Centralizes shortcut list state and persistence.
 */

import { createStore, createReducer } from '/lib/store.js';

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

/**
 * Create shortcuts store
 */
export function createShortcutsStore() {
  const store = createStore([], shortcutsReducer, { debug: false });

  // Auto-load shortcuts on creation
  loadShortcuts(store);

  return store;
}

/**
 * Load shortcuts from API
 */
export async function loadShortcuts(store) {
  try {
    const res = await fetch("/shortcuts");
    const data = await res.json();
    store.dispatch({ type: SHORTCUTS_ACTIONS.LOAD, items: data });
  } catch {
    store.dispatch({ type: SHORTCUTS_ACTIONS.LOAD, items: [] });
  }
}

/**
 * Save shortcuts to API
 */
export async function saveShortcuts(shortcuts) {
  try {
    await fetch("/shortcuts", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": document.cookie.split('; ').find(r => r.startsWith('csrf_token='))?.split('=')[1] || ''
      },
      body: JSON.stringify(shortcuts),
    });
  } catch {
    console.error('[Shortcuts] Failed to save');
  }
}

/**
 * Add shortcut
 */
export function addShortcut(store, item) {
  store.dispatch({ type: SHORTCUTS_ACTIONS.ADD, item });
  saveShortcuts(store.getState());
}

/**
 * Remove shortcut
 */
export function removeShortcut(store, index) {
  store.dispatch({ type: SHORTCUTS_ACTIONS.REMOVE, index });
  saveShortcuts(store.getState());
}

export { SHORTCUTS_ACTIONS };
