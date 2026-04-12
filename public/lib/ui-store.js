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
 *     tiles:     { [id]: { id, type, props, x } },  // x = horizontal position
 *     order:     [id, id, ...],   // derived: tiles sorted by x
 *     focusedId: id | null,
 *   }
 *
 * Position is a property of the tile itself (the `x` field) rather than
 * a separate array.  Today x is a 1-D integer; the clusters design
 * (docs/tile-clusters-design.md) will extend this to (cluster, x, y).
 * `state.order` is kept as a derived convenience so consumers that just
 * need "left-to-right list of ids" don't change.
 *
 * Invariants (enforced by the reducer):
 *   - order is derived from tiles sorted by x
 *   - focusedId is null or a key of tiles
 *   - ids are unique (tiles is a map, not a list)
 *   - every mutation returns a new state object (structural sharing)
 */

import { createStore } from "./store.js";

const STORAGE_KEY = "katulong-ui-v1";
const VERSION = 1;

export const EMPTY_STATE = Object.freeze({
  version: VERSION,
  tiles: Object.freeze({}),
  order: Object.freeze([]),
  focusedId: null,
});

// ─── Helpers ─────────────────────────────────────────────────────────
/** Derive the order array from tiles by sorting on x. */
function deriveOrder(tiles) {
  return Object.values(tiles)
    .sort((a, b) => a.x - b.x)
    .map(t => t.id);
}

/** One past the highest x coordinate (or 0 if no tiles). */
function nextX(tiles) {
  let max = -1;
  for (const t of Object.values(tiles)) {
    if (typeof t.x === "number" && t.x > max) max = t.x;
  }
  return max + 1;
}

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
      const { tile, focus = false, insertAt = "end", insertAfter } = action;
      if (!tile || !tile.id || !tile.type) return state;
      if (state.tiles[tile.id]) {
        // Already present — optionally focus, but don't duplicate.
        return focus ? { ...state, focusedId: tile.id } : state;
      }
      const newTile = { id: tile.id, type: tile.type, props: { ...(tile.props || {}) } };
      let newTiles;
      // Determine the anchor tile for positional insertion:
      //   insertAfter: <id>  — explicit tile to insert after (preferred)
      //   insertAt: "afterFocus" — insert after the currently focused tile
      const anchorId = insertAfter || (insertAt === "afterFocus" ? state.focusedId : null);
      if (anchorId && state.tiles[anchorId]) {
        const insertX = state.tiles[anchorId].x + 1;
        newTile.x = insertX;
        // Shift tiles at or past the insertion point to make room
        newTiles = {};
        for (const [id, t] of Object.entries(state.tiles)) {
          newTiles[id] = t.x >= insertX ? { ...t, x: t.x + 1 } : t;
        }
        newTiles[tile.id] = newTile;
      } else {
        newTile.x = nextX(state.tiles);
        newTiles = { ...state.tiles, [tile.id]: newTile };
      }
      return {
        ...state,
        tiles: newTiles,
        order: deriveOrder(newTiles),
        focusedId: focus ? tile.id : state.focusedId,
      };
    }

    case REMOVE_TILE: {
      const { id } = action;
      if (!state.tiles[id]) return state;
      const { [id]: _removed, ...restTiles } = state.tiles;
      const newOrder = deriveOrder(restTiles);
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
      // Reassign x coordinates from the new order
      const newTiles = { ...state.tiles };
      cleaned.forEach((id, i) => {
        if (newTiles[id].x !== i) {
          newTiles[id] = { ...newTiles[id], x: i };
        }
      });
      return { ...state, tiles: newTiles, order: cleaned };
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

/** Coerce an arbitrary object into a valid ui-store state.
 *  Handles migration: tiles may or may not carry `x`. When absent,
 *  position is backfilled from raw.order (the old persistence format). */
export function normalize(raw) {
  if (!raw || typeof raw !== "object") return EMPTY_STATE;
  const tiles = {};
  if (raw.tiles && typeof raw.tiles === "object") {
    for (const [id, t] of Object.entries(raw.tiles)) {
      if (t && typeof t.type === "string") {
        tiles[id] = { id, type: t.type, props: { ...(t.props || {}) } };
        if (typeof t.x === "number") tiles[id].x = t.x;
      }
    }
  }
  // Backfill x for tiles that lack it (old format or manual state).
  const needsX = Object.keys(tiles).filter(id => typeof tiles[id].x !== "number");
  if (needsX.length > 0) {
    let pos = nextX(tiles); // start after highest existing x (0 if none)
    const orderHint = Array.isArray(raw.order) ? raw.order : [];
    const pending = new Set(needsX);
    for (const id of orderHint) {
      if (pending.has(id)) { tiles[id].x = pos++; pending.delete(id); }
    }
    for (const id of pending) { tiles[id].x = pos++; }
  }
  const order = deriveOrder(tiles);
  const focusedId = raw.focusedId && tiles[raw.focusedId] ? raw.focusedId : (order[0] || null);
  return { version: VERSION, tiles, order, focusedId };
}

// ─── Persistence ─────────────────────────────────────────────────────
/**
 * Serialize state for localStorage. Accepts an `isPersistable(type, props)`
 * predicate supplied by the host so this module never needs to know
 * about renderer internals. Props are forwarded for instance-level
 * persistence decisions (e.g. file-backed document tiles persist,
 * content-backed ones don't).
 */
export function serialize(state, isPersistable = () => true) {
  const tiles = {};
  for (const [id, t] of Object.entries(state.tiles)) {
    if (isPersistable(t.type, t.props || {})) tiles[id] = t;
  }
  // Derive order from the persisted tiles' x coordinates. The order
  // field is redundant (x is authoritative) but included for backward
  // compat if the user ever rolls back to a pre-coordinate build.
  const order = deriveOrder(tiles);
  const focusedId = state.focusedId && tiles[state.focusedId] ? state.focusedId : (order[0] || null);
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
