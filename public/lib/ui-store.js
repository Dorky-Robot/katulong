/**
 * UI Store — single source of truth for tile UI state
 *
 * See docs/tile-state-rewrite.md for the original "why", and
 * docs/tile-clusters-design.md for the multi-cluster extension (FP1).
 *
 * State shape (v2):
 *   {
 *     version: 2,
 *     activeClusterId: string,
 *     clusters: { [id]: { id, name? } },
 *     tiles: { [id]: { id, type, props, x, clusterId } },
 *     focusedIdByCluster: { [clusterId]: id | null },
 *
 *     // Derived conveniences, scoped to the active cluster:
 *     order: [id, ...],       // active cluster's tiles sorted by x
 *     focusedId: id | null,   // = focusedIdByCluster[activeClusterId]
 *   }
 *
 * Each tile carries its own `clusterId` and `x`. `order`/`focusedId` at
 * the top level are *derived* from the active cluster only, so consumers
 * that don't care about clusters keep their existing contract.
 *
 * v1 → v2 migration: a persisted v1 store is treated as a single cluster
 * named "default". All tiles get `clusterId: "default"`, and the old
 * top-level `focusedId` becomes `focusedIdByCluster.default`.
 *
 * Invariants (enforced by the reducer):
 *   - Every tile has a `clusterId` that exists in `clusters`.
 *   - `activeClusterId` is always a key of `clusters`.
 *   - `focusedIdByCluster[c]` is null or a tile whose `clusterId === c`.
 *   - `order` is derived from tiles in activeCluster, sorted by x.
 *   - Every mutation returns a new state object (structural sharing).
 */

import { createStore } from "./store.js";

const STORAGE_KEY = "katulong-ui-v1"; // same key; version field discriminates
const VERSION = 2;
export const DEFAULT_CLUSTER_ID = "default";

export const EMPTY_STATE = Object.freeze({
  version: VERSION,
  activeClusterId: DEFAULT_CLUSTER_ID,
  clusters: Object.freeze({ [DEFAULT_CLUSTER_ID]: Object.freeze({ id: DEFAULT_CLUSTER_ID }) }),
  tiles: Object.freeze({}),
  focusedIdByCluster: Object.freeze({ [DEFAULT_CLUSTER_ID]: null }),
  order: Object.freeze([]),
  focusedId: null,
});

// ─── Helpers ─────────────────────────────────────────────────────────
function clusterTiles(tiles, clusterId) {
  return Object.values(tiles).filter(t => t.clusterId === clusterId);
}

function deriveOrder(tiles, clusterId) {
  return clusterTiles(tiles, clusterId)
    .sort((a, b) => a.x - b.x)
    .map(t => t.id);
}

function nextX(tiles, clusterId) {
  let max = -1;
  for (const t of Object.values(tiles)) {
    if (t.clusterId === clusterId && typeof t.x === "number" && t.x > max) max = t.x;
  }
  return max + 1;
}

function withDerived(state) {
  const order = deriveOrder(state.tiles, state.activeClusterId);
  const focusedId = state.focusedIdByCluster[state.activeClusterId] ?? null;
  return { ...state, order, focusedId };
}

// ─── Action types ────────────────────────────────────────────────────
export const ADD_TILE       = "ui/ADD_TILE";
export const REMOVE_TILE    = "ui/REMOVE_TILE";
export const REORDER        = "ui/REORDER";
export const FOCUS_TILE     = "ui/FOCUS_TILE";
export const UPDATE_PROPS   = "ui/UPDATE_PROPS";
export const RESET          = "ui/RESET";
export const ADD_CLUSTER    = "ui/ADD_CLUSTER";
export const REMOVE_CLUSTER = "ui/REMOVE_CLUSTER";
export const SWITCH_CLUSTER = "ui/SWITCH_CLUSTER";

// ─── Reducer ─────────────────────────────────────────────────────────
function reducer(state = EMPTY_STATE, action) {
  switch (action.type) {
    case ADD_TILE: {
      const { tile, focus = false, insertAt = "end", insertAfter } = action;
      if (!tile || !tile.id || !tile.type) return state;
      if (state.tiles[tile.id]) {
        if (!focus) return state;
        const existingCluster = state.tiles[tile.id].clusterId;
        const focusedIdByCluster = { ...state.focusedIdByCluster, [existingCluster]: tile.id };
        return withDerived({ ...state, focusedIdByCluster });
      }
      const clusterId = action.clusterId || state.activeClusterId;
      if (!state.clusters[clusterId]) return state;
      const newTile = {
        id: tile.id,
        type: tile.type,
        props: { ...(tile.props || {}) },
        clusterId,
      };
      let newTiles;
      let anchorId = insertAfter;
      if (!anchorId && insertAt === "afterFocus") {
        const focused = state.focusedIdByCluster[clusterId];
        if (focused && state.tiles[focused]?.clusterId === clusterId) anchorId = focused;
      }
      if (anchorId && state.tiles[anchorId] && state.tiles[anchorId].clusterId === clusterId) {
        const insertX = state.tiles[anchorId].x + 1;
        newTile.x = insertX;
        newTiles = {};
        for (const [id, t] of Object.entries(state.tiles)) {
          newTiles[id] = (t.clusterId === clusterId && t.x >= insertX)
            ? { ...t, x: t.x + 1 }
            : t;
        }
        newTiles[tile.id] = newTile;
      } else {
        newTile.x = nextX(state.tiles, clusterId);
        newTiles = { ...state.tiles, [tile.id]: newTile };
      }
      const focusedIdByCluster = focus
        ? { ...state.focusedIdByCluster, [clusterId]: tile.id }
        : state.focusedIdByCluster;
      return withDerived({ ...state, tiles: newTiles, focusedIdByCluster });
    }

    case REMOVE_TILE: {
      const { id } = action;
      const existing = state.tiles[id];
      if (!existing) return state;
      const { [id]: _removed, ...restTiles } = state.tiles;
      const focusedIdByCluster = { ...state.focusedIdByCluster };
      if (focusedIdByCluster[existing.clusterId] === id) {
        const clusterOrder = deriveOrder(state.tiles, existing.clusterId);
        const remainingOrder = deriveOrder(restTiles, existing.clusterId);
        const removedIdx = clusterOrder.indexOf(id);
        focusedIdByCluster[existing.clusterId] =
          remainingOrder[removedIdx] || remainingOrder[removedIdx - 1] || null;
      }
      return withDerived({ ...state, tiles: restTiles, focusedIdByCluster });
    }

    case REORDER: {
      const { order } = action;
      if (!Array.isArray(order)) return state;
      const clusterId = action.clusterId || state.activeClusterId;
      if (!state.clusters[clusterId]) return state;
      const known = new Set(
        Object.values(state.tiles)
          .filter(t => t.clusterId === clusterId)
          .map(t => t.id),
      );
      const cleaned = order.filter(id => known.has(id));
      const seen = new Set(cleaned);
      const currentOrder = deriveOrder(state.tiles, clusterId);
      for (const id of currentOrder) {
        if (!seen.has(id)) cleaned.push(id);
      }
      if (cleaned.length === currentOrder.length
          && cleaned.every((id, i) => id === currentOrder[i])) {
        return state;
      }
      const newTiles = { ...state.tiles };
      cleaned.forEach((id, i) => {
        if (newTiles[id].x !== i) {
          newTiles[id] = { ...newTiles[id], x: i };
        }
      });
      return withDerived({ ...state, tiles: newTiles });
    }

    case FOCUS_TILE: {
      const { id } = action;
      if (id === null) {
        const current = state.focusedIdByCluster[state.activeClusterId];
        if (current === null) return state;
        const focusedIdByCluster = { ...state.focusedIdByCluster, [state.activeClusterId]: null };
        return withDerived({ ...state, focusedIdByCluster });
      }
      const tile = state.tiles[id];
      if (!tile) return state;
      // A tile can only be focused within its own cluster. If the caller
      // asks to focus a tile in a non-active cluster, no-op — they need
      // to switchCluster first.
      if (tile.clusterId !== state.activeClusterId) return state;
      if (state.focusedIdByCluster[tile.clusterId] === id) return state;
      const focusedIdByCluster = { ...state.focusedIdByCluster, [tile.clusterId]: id };
      return withDerived({ ...state, focusedIdByCluster });
    }

    case UPDATE_PROPS: {
      const { id, patch } = action;
      const existing = state.tiles[id];
      if (!existing || !patch) return state;
      let changed = false;
      for (const k of Object.keys(patch)) {
        if (existing.props[k] !== patch[k]) { changed = true; break; }
      }
      if (!changed) return state;
      const newTile = { ...existing, props: { ...existing.props, ...patch } };
      return withDerived({ ...state, tiles: { ...state.tiles, [id]: newTile } });
    }

    case ADD_CLUSTER: {
      const { cluster, switchTo = false } = action;
      if (!cluster || !cluster.id) return state;
      if (state.clusters[cluster.id]) return state;
      const clusters = {
        ...state.clusters,
        [cluster.id]: { id: cluster.id, ...(cluster.name ? { name: cluster.name } : {}) },
      };
      const focusedIdByCluster = { ...state.focusedIdByCluster, [cluster.id]: null };
      const next = { ...state, clusters, focusedIdByCluster };
      if (switchTo) next.activeClusterId = cluster.id;
      return withDerived(next);
    }

    case REMOVE_CLUSTER: {
      const { id } = action;
      if (!state.clusters[id]) return state;
      if (Object.keys(state.clusters).length <= 1) return state;
      const clusters = { ...state.clusters };
      delete clusters[id];
      const focusedIdByCluster = { ...state.focusedIdByCluster };
      delete focusedIdByCluster[id];
      const tiles = {};
      for (const [tid, t] of Object.entries(state.tiles)) {
        if (t.clusterId !== id) tiles[tid] = t;
      }
      let activeClusterId = state.activeClusterId;
      if (activeClusterId === id) activeClusterId = Object.keys(clusters)[0];
      return withDerived({ ...state, clusters, tiles, focusedIdByCluster, activeClusterId });
    }

    case SWITCH_CLUSTER: {
      const { id } = action;
      if (!state.clusters[id]) return state;
      if (state.activeClusterId === id) return state;
      return withDerived({ ...state, activeClusterId: id });
    }

    case RESET: {
      const { state: next } = action;
      return normalize(next);
    }

    default:
      return state;
  }
}

// ─── Normalize (migration + coercion) ────────────────────────────────
/**
 * Coerce an arbitrary object into a valid v2 state. Handles:
 *   - Null/invalid input (returns EMPTY_STATE).
 *   - v1 → v2 migration: tiles without clusterId get DEFAULT_CLUSTER_ID,
 *     and the old top-level focusedId becomes focusedIdByCluster.default.
 *   - x backfill from raw.order for tiles that lack it (v1 format).
 */
export function normalize(raw) {
  if (!raw || typeof raw !== "object") return EMPTY_STATE;

  const isV2 = typeof raw.activeClusterId === "string"
    && raw.clusters && typeof raw.clusters === "object";

  const clusters = {};
  if (isV2) {
    for (const [id, c] of Object.entries(raw.clusters)) {
      if (c && typeof c === "object") {
        clusters[id] = { id, ...(typeof c.name === "string" ? { name: c.name } : {}) };
      }
    }
  }
  if (!clusters[DEFAULT_CLUSTER_ID]) {
    clusters[DEFAULT_CLUSTER_ID] = { id: DEFAULT_CLUSTER_ID };
  }

  const tiles = {};
  if (raw.tiles && typeof raw.tiles === "object") {
    for (const [id, t] of Object.entries(raw.tiles)) {
      if (!t || typeof t.type !== "string") continue;
      const clusterId = (typeof t.clusterId === "string" && clusters[t.clusterId])
        ? t.clusterId
        : DEFAULT_CLUSTER_ID;
      tiles[id] = {
        id,
        type: t.type,
        props: { ...(t.props || {}) },
        clusterId,
      };
      if (typeof t.x === "number") tiles[id].x = t.x;
    }
  }

  // x backfill (per cluster) — v1 tiles don't carry x; reconstruct from
  // raw.order (global for v1 — accurate since there's only one cluster).
  const orderHint = Array.isArray(raw.order) ? raw.order : [];
  const needsX = new Set(
    Object.keys(tiles).filter(id => typeof tiles[id].x !== "number"),
  );
  if (needsX.size > 0) {
    const perClusterNext = {};
    for (const id of Object.keys(clusters)) perClusterNext[id] = nextX(tiles, id);
    for (const id of orderHint) {
      if (needsX.has(id)) {
        const cid = tiles[id].clusterId;
        tiles[id].x = perClusterNext[cid]++;
        needsX.delete(id);
      }
    }
    for (const id of needsX) {
      const cid = tiles[id].clusterId;
      tiles[id].x = perClusterNext[cid]++;
    }
  }

  // focusedIdByCluster
  const focusedIdByCluster = {};
  for (const id of Object.keys(clusters)) focusedIdByCluster[id] = null;
  if (isV2 && raw.focusedIdByCluster && typeof raw.focusedIdByCluster === "object") {
    for (const [cid, fid] of Object.entries(raw.focusedIdByCluster)) {
      if (!clusters[cid]) continue;
      if (fid && tiles[fid] && tiles[fid].clusterId === cid) {
        focusedIdByCluster[cid] = fid;
      }
    }
  } else if (typeof raw.focusedId === "string") {
    const fid = raw.focusedId;
    if (tiles[fid] && tiles[fid].clusterId === DEFAULT_CLUSTER_ID) {
      focusedIdByCluster[DEFAULT_CLUSTER_ID] = fid;
    }
  }
  for (const cid of Object.keys(clusters)) {
    if (focusedIdByCluster[cid]) continue;
    const order = deriveOrder(tiles, cid);
    focusedIdByCluster[cid] = order[0] || null;
  }

  const activeClusterId = (isV2 && clusters[raw.activeClusterId])
    ? raw.activeClusterId
    : DEFAULT_CLUSTER_ID;

  return withDerived({
    version: VERSION,
    activeClusterId,
    clusters,
    tiles,
    focusedIdByCluster,
    order: [],
    focusedId: null,
  });
}

// ─── Persistence ─────────────────────────────────────────────────────
/**
 * Serialize state for localStorage. Derived fields (order, focusedId)
 * are NOT written — they're re-derived on normalize.
 */
export function serialize(state, isPersistable = () => true) {
  const tiles = {};
  for (const [id, t] of Object.entries(state.tiles)) {
    if (isPersistable(t.type, t.props || {})) tiles[id] = t;
  }
  const focusedIdByCluster = {};
  for (const [cid, fid] of Object.entries(state.focusedIdByCluster)) {
    focusedIdByCluster[cid] = (fid && tiles[fid]) ? fid : null;
  }
  return {
    version: VERSION,
    activeClusterId: state.activeClusterId,
    clusters: state.clusters,
    tiles,
    focusedIdByCluster,
  };
}

export function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed) return null;
    if (parsed.version !== 1 && parsed.version !== VERSION) return null;
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
export function createUiStore({ initialState = EMPTY_STATE, isPersistable = () => true, debug = false } = {}) {
  const store = createStore(normalize(initialState), reducer, { debug });

  store.subscribe((state) => saveToStorage(state, isPersistable));

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    dispatch:  store.dispatch,
    addTile:       (tile, opts = {}) => store.dispatch({ type: ADD_TILE, tile, ...opts }),
    removeTile:    (id)              => store.dispatch({ type: REMOVE_TILE, id }),
    reorder:       (order, opts = {}) => store.dispatch({ type: REORDER, order, ...opts }),
    focusTile:     (id)              => store.dispatch({ type: FOCUS_TILE, id }),
    updateProps:   (id, patch)       => store.dispatch({ type: UPDATE_PROPS, id, patch }),
    reset:         (state)           => store.dispatch({ type: RESET, state }),
    addCluster:    (cluster, opts = {}) => store.dispatch({ type: ADD_CLUSTER, cluster, ...opts }),
    removeCluster: (id)              => store.dispatch({ type: REMOVE_CLUSTER, id }),
    switchCluster: (id)              => store.dispatch({ type: SWITCH_CLUSTER, id }),
  };
}
