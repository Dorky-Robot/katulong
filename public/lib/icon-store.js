/**
 * Icon Store — per-session tab icon overrides.
 *
 * Replaces the mutable `sessionIcons: Map` in app.js with a
 * reducer-driven store. Icons are set via OSC 7337 escape sequences
 * from terminal processes or hydrated from the server session list.
 *
 * State shape: { icons: { [sessionName]: iconName } }
 */

import { createStore } from "./store.js";

export const EMPTY_STATE = Object.freeze({ icons: Object.freeze({}) });

// Action types
export const SET_ICON    = "icon/SET";
export const REMOVE_ICON = "icon/REMOVE";
export const RENAME      = "icon/RENAME";

function reducer(state = EMPTY_STATE, action) {
  switch (action.type) {
    case SET_ICON: {
      if (state.icons[action.session] === action.icon) return state;
      return { icons: { ...state.icons, [action.session]: action.icon } };
    }
    case REMOVE_ICON: {
      if (!(action.session in state.icons)) return state;
      const { [action.session]: _, ...rest } = state.icons;
      return { icons: rest };
    }
    case RENAME: {
      if (!(action.oldName in state.icons)) return state;
      const { [action.oldName]: icon, ...rest } = state.icons;
      return { icons: { ...rest, [action.newName]: icon } };
    }
    default:
      return state;
  }
}

export function createIconStore() {
  const store = createStore(EMPTY_STATE, reducer);

  return {
    getState:  store.getState,
    dispatch:  store.dispatch,
    subscribe: store.subscribe,
    // Convenience
    getIcon: (session) => store.getState().icons[session] || null,
    setIcon: (session, icon) => store.dispatch({ type: SET_ICON, session, icon }),
    removeIcon: (session) => store.dispatch({ type: REMOVE_ICON, session }),
    rename: (oldName, newName) => store.dispatch({ type: RENAME, oldName, newName }),
  };
}
