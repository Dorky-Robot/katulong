/**
 * UI Store — single source of truth for tile UI state
 *
 * See docs/tile-state-rewrite.md for the "why". Summary: previously
 * tile state was spread across the carousel, windowTabSet, and
 * sessionStore, each mutated at every call site. This collapses it
 * into one reducer-driven atom. Tab bar and carousel both derive from
 * it; persistence and URL sync are reactive subscriptions.
 *
 * State shape:
 *   {
 *     version: 1,
 *     tiles:     { [id]: { id, type, props } },
 *     order:     [id, id, ...],   // left → right, permutation of tiles keys
 *     focusedId: id | null,
 *   }
 *
 * Invariants (enforced by the reducer):
 *   - order is a permutation of Object.keys(tiles)
 *   - focusedId is null or a key of tiles
 *   - ids are unique (tiles is a map, not a list)
 *   - every mutation returns a new state object (structural sharing)
 */

import { createStore } from "/lib/store.js";

const STORAGE_KEY = "katulong-ui-v1";
const VERSION = 1;

export const EMPTY_STATE = Object.freeze({
  version: VERSION,
  tiles: Object.freeze({}),
  order: Object.freeze([]),
  focusedId: null,
});

// ─── Action types ────────────────────────────────────────────────────
export const ADD_TILE     = "ui/ADD_TILE";
export const REMOVE_TILE  = "ui/REMOVE_TILE";
export const REORDER      = "ui/REORDER";
export const FOCUS_TILE   = "ui/FOCUS_TILE";
export const UPDATE_PROPS = "ui/UPDATE_PROPS";
export const RESET        = "ui/RESET";

// ─── Reducer ─────────────────────────────────────────────────────────
function reducer(state = EMPTY_STATE, action) {
  switch (action.type) {
    case ADD_TILE: {
      const { tile, focus = false, insertAt = "end" } = action;
      if (!tile || !tile.id || !tile.type) return state;
      if (state.tiles[tile.id]) {
        // Already present — optionally focus, but don't duplicate.
        return focus ? { ...state, focusedId: tile.id } : state;
      }
      const newTile = { id: tile.id, type: tile.type, props: { ...(tile.props || {}) } };
      const newTiles = { ...state.tiles, [tile.id]: newTile };
      let newOrder;
      if (insertAt === "afterFocus" && state.focusedId) {
        const idx = state.order.indexOf(state.focusedId);
        newOrder = [...state.order.slice(0, idx + 1), tile.id, ...state.order.slice(idx + 1)];
      } else {
        newOrder = [...state.order, tile.id];
      }
      return {
        ...state,
        tiles: newTiles,
        order: newOrder,
        focusedId: focus ? tile.id : state.focusedId,
      };
    }

    case REMOVE_TILE: {
      const { id } = action;
      if (!state.tiles[id]) return state;
      const { [id]: _removed, ...restTiles } = state.tiles;
      const newOrder = state.order.filter(x => x !== id);
      let focusedId = state.focusedId;
      if (focusedId === id) {
        // Focus the neighbor to the right (or left if we removed the
        // last card). Matches carousel's "focus right neighbor on
        // close" behavior without needing the host to reimplement it.
        const removedIdx = state.order.indexOf(id);
        focusedId = newOrder[removedIdx] || newOrder[removedIdx - 1] || null;
      }
      return { ...state, tiles: restTiles, order: newOrder, focusedId };
    }

    case REORDER: {
      const { order } = action;
      if (!Array.isArray(order)) return state;
      // Defend against drops that omit ids or smuggle unknowns — fold
      // in any missing tiles at the end so state never desyncs from
      // `tiles`. Unknown ids are dropped.
      const known = new Set(Object.keys(state.tiles));
      const cleaned = order.filter(id => known.has(id));
      const seen = new Set(cleaned);
      for (const id of state.order) {
        if (!seen.has(id)) cleaned.push(id);
      }
      // No-op if identical
      if (cleaned.length === state.order.length && cleaned.every((id, i) => id === state.order[i])) {
        return state;
      }
      return { ...state, order: cleaned };
    }

    case FOCUS_TILE: {
      const { id } = action;
      if (id !== null && !state.tiles[id]) return state;
      if (state.focusedId === id) return state;
      return { ...state, focusedId: id };
    }

    case UPDATE_PROPS: {
      const { id, patch } = action;
      const existing = state.tiles[id];
      if (!existing || !patch) return state;
      // Shallow-merge patch into props. Bail if nothing actually
      // changed — subscribers shouldn't fire on no-op UPDATE_PROPS.
      let changed = false;
      for (const k of Object.keys(patch)) {
        if (existing.props[k] !== patch[k]) { changed = true; break; }
      }
      if (!changed) return state;
      const newTile = { ...existing, props: { ...existing.props, ...patch } };
      return { ...state, tiles: { ...state.tiles, [id]: newTile } };
    }

    case RESET: {
      const { state: next } = action;
      return normalize(next);
    }

    default:
      return state;
  }
}

/** Coerce an arbitrary object into a valid ui-store state. */
export function normalize(raw) {
  if (!raw || typeof raw !== "object") return EMPTY_STATE;
  const tiles = {};
  if (raw.tiles && typeof raw.tiles === "object") {
    for (const [id, t] of Object.entries(raw.tiles)) {
      if (t && typeof t.type === "string") {
        tiles[id] = { id, type: t.type, props: { ...(t.props || {}) } };
      }
    }
  }
  const known = new Set(Object.keys(tiles));
  const order = Array.isArray(raw.order) ? raw.order.filter(id => known.has(id)) : [];
  // Append any tiles that exist but weren't in order (corrupt save)
  for (const id of known) {
    if (!order.includes(id)) order.push(id);
  }
  const focusedId = raw.focusedId && known.has(raw.focusedId) ? raw.focusedId : (order[0] || null);
  return { version: VERSION, tiles, order, focusedId };
}

// ─── Persistence ─────────────────────────────────────────────────────
/**
 * Serialize state for localStorage. Accepts an `isPersistable(type)`
 * predicate supplied by the host so this module never needs to know
 * about renderer internals.
 */
export function serialize(state, isPersistable = () => true) {
  const tiles = {};
  for (const [id, t] of Object.entries(state.tiles)) {
    if (isPersistable(t.type)) tiles[id] = t;
  }
  const known = new Set(Object.keys(tiles));
  const order = state.order.filter(id => known.has(id));
  const focusedId = state.focusedId && known.has(state.focusedId) ? state.focusedId : (order[0] || null);
  return { version: VERSION, tiles, order, focusedId };
}

export function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== VERSION) return null;
    return normalize(parsed);
  } catch (_) {
    return null;
  }
}

export function saveToStorage(state, isPersistable) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(state, isPersistable)));
  } catch (_) { /* quota exceeded, etc. — silently skip */ }
}

// ─── Store factory ───────────────────────────────────────────────────
/**
 * Create a UI store. Pass `isPersistable(type)` so persistence can
 * filter non-persistable tile types without this module importing
 * the renderer registry.
 */
export function createUiStore({ initialState = EMPTY_STATE, isPersistable = () => true, debug = false } = {}) {
  const store = createStore(normalize(initialState), reducer, { debug });

  // Persist on every change. Cheap: JSON.stringify of a small object.
  store.subscribe((state) => saveToStorage(state, isPersistable));

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    dispatch:  store.dispatch,
    // Convenience action creators — call sites read more like a
    // command API than raw dispatches, and typos throw at the source.
    addTile:     (tile, opts = {}) => store.dispatch({ type: ADD_TILE, tile, ...opts }),
    removeTile:  (id)              => store.dispatch({ type: REMOVE_TILE, id }),
    reorder:     (order)           => store.dispatch({ type: REORDER, order }),
    focusTile:   (id)              => store.dispatch({ type: FOCUS_TILE, id }),
    updateProps: (id, patch)       => store.dispatch({ type: UPDATE_PROPS, id, patch }),
    reset:       (state)           => store.dispatch({ type: RESET, state }),
  };
}
