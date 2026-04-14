/**
 * UI Store — v3 spatial tile state.
 *
 * See docs/tile-state-rewrite.md for the original "why" and
 * docs/tile-clusters-design.md for the multi-cluster extension.
 *
 * State shape (v3):
 *   {
 *     version: 3,
 *     clusters:               Tile[][][],           // SOURCE OF TRUTH: [c][col][row]
 *     activeClusterIdx:       number,
 *     focusedTileIdByCluster: (TileId | null)[],    // parallel to clusters
 *
 *     // Derived conveniences (rebuilt by withDerived after every mutation):
 *     tiles:     { [id]: Tile },   // flattened across all clusters
 *     order:     TileId[],         // active cluster, column-major top→bottom
 *     focusedId: TileId | null,    // = focusedTileIdByCluster[activeClusterIdx]
 *   }
 *
 * A `Tile` is `{ id, type, props }` — nothing positional. Position in the
 * 3D array IS location. Moving a tile is a splice-remove + splice-insert;
 * there are no coordinate cascades, no `x` or `clusterId` fields to keep
 * in sync.
 *
 * Persistence stores only the source-of-truth fields; the derived map and
 * flat order are recomputed by `withDerived` on load.
 *
 * Migration:
 *   v1 → v3: one cluster, single-slot columns in the v1 order.
 *   v2 → v3: one cluster per v2 cluster (keys sorted), v2 tiles grouped by
 *            `tile.x` into single-slot columns ordered by x ascending.
 *
 * Invariants (tested):
 *   - clusters.length >= 1 and === focusedTileIdByCluster.length
 *   - 0 ≤ activeClusterIdx < clusters.length
 *   - No column is `[]` at rest (pruned after REMOVE_TILE).
 *   - focusedTileIdByCluster[c] is null or appears somewhere in clusters[c].
 *   - Tile ids are globally unique across the whole tree.
 */

import { createStore } from "./store.js";

const STORAGE_KEY = "katulong-ui-v1"; // unchanged; version field discriminates
const VERSION = 3;

// ─── Empty state ─────────────────────────────────────────────────────
// One cluster always exists. The workspace can't be completely empty of
// clusters — MC1 mirrors today's "there's always a default" invariant.
export const EMPTY_STATE = Object.freeze({
  version: VERSION,
  clusters: Object.freeze([Object.freeze([])]),
  activeClusterIdx: 0,
  focusedTileIdByCluster: Object.freeze([null]),
  tiles: Object.freeze({}),
  order: Object.freeze([]),
  focusedId: null,
});

// ─── Derived-field recomputation ─────────────────────────────────────
/**
 * Rebuild `tiles`, `order`, `focusedId` from the 3D source-of-truth.
 * Called after every reducer step. O(N) across all tiles in all clusters.
 */
// Reserved tile ids that would poison the derived `tiles` map prototype
// if used as plain-object keys. Rejected at the boundary (normalize + ADD_TILE)
// so no later consumer needs to guard against them.
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

function withDerived(state) {
  const tiles = {};
  for (const cluster of state.clusters) {
    for (const column of cluster) {
      for (const tile of column) tiles[tile.id] = tile;
    }
  }
  const activeCluster = state.clusters[state.activeClusterIdx] || [];
  const order = [];
  for (const column of activeCluster) {
    for (const tile of column) order.push(tile.id);
  }
  const focusedId = state.focusedTileIdByCluster[state.activeClusterIdx] ?? null;
  return { ...state, tiles, order, focusedId };
}

// ─── Path helpers (pure) ─────────────────────────────────────────────
/** Find the 3D path of a tile by id, or null. O(total tiles). */
function findPath(clusters, id) {
  for (let c = 0; c < clusters.length; c++) {
    const cluster = clusters[c];
    for (let col = 0; col < cluster.length; col++) {
      const column = cluster[col];
      for (let row = 0; row < column.length; row++) {
        if (column[row].id === id) return { c, col, row };
      }
    }
  }
  return null;
}

/** Structural-sharing splice: return a new `clusters` with `mutate(cluster[c])`. */
function replaceCluster(clusters, c, mutate) {
  const next = clusters.slice();
  next[c] = mutate(clusters[c]);
  return next;
}

function replaceColumn(cluster, col, mutate) {
  const next = cluster.slice();
  next[col] = mutate(cluster[col]);
  return next;
}

/** Replace a tile at a known path. Pure. */
function replaceTileAt(clusters, { c, col, row }, nextTile) {
  return replaceCluster(clusters, c, (cluster) =>
    replaceColumn(cluster, col, (column) => {
      const next = column.slice();
      next[row] = nextTile;
      return next;
    }),
  );
}

/**
 * Remove a tile at a known path. If the column becomes empty, prune it.
 * Returns the new `clusters` array.
 */
function removeTileAt(clusters, { c, col, row }) {
  return replaceCluster(clusters, c, (cluster) => {
    const column = cluster[col];
    if (column.length === 1) {
      const next = cluster.slice();
      next.splice(col, 1);
      return next;
    }
    return replaceColumn(cluster, col, (column) => {
      const next = column.slice();
      next.splice(row, 1);
      return next;
    });
  });
}

/** Append a new single-slot column to cluster c at `col`. */
function insertColumnAt(clusters, c, col, tile) {
  return replaceCluster(clusters, c, (cluster) => {
    const next = cluster.slice();
    next.splice(col, 0, [tile]);
    return next;
  });
}

/** Flatten one cluster column-major top→bottom. */
function clusterOrder(cluster) {
  const out = [];
  for (const column of cluster) for (const t of column) out.push(t.id);
  return out;
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
      if (RESERVED_IDS.has(tile.id)) return state;

      // Already present? Optionally shift focus and short-circuit — same
      // contract as v2, so callers that re-fire ADD_TILE as "focus this"
      // keep working. Cross-cluster focus-via-ADD_TILE is a no-op: callers
      // must switchCluster first. Without this, focusedTileIdByCluster
      // would update in the background cluster but `state.focusedId`
      // (the derived active-cluster field) would silently disagree.
      if (state.tiles[tile.id]) {
        if (!focus) return state;
        const existing = findPath(state.clusters, tile.id);
        if (!existing) return state;
        if (existing.c !== state.activeClusterIdx) return state;
        if (state.focusedTileIdByCluster[existing.c] === tile.id) return state;
        const focusedTileIdByCluster = state.focusedTileIdByCluster.slice();
        focusedTileIdByCluster[existing.c] = tile.id;
        return withDerived({ ...state, focusedTileIdByCluster });
      }

      const clusterIdx = typeof action.clusterIdx === "number"
        ? action.clusterIdx
        : state.activeClusterIdx;
      if (clusterIdx < 0 || clusterIdx >= state.clusters.length) return state;

      const newTile = {
        id: tile.id,
        type: tile.type,
        props: { ...(tile.props || {}) },
      };

      // Resolve insertion column.
      let anchorId = insertAfter;
      if (!anchorId && insertAt === "afterFocus") {
        const focusedHere = state.focusedTileIdByCluster[clusterIdx];
        if (focusedHere && findPath(state.clusters, focusedHere)?.c === clusterIdx) {
          anchorId = focusedHere;
        }
      }

      let targetCol;
      if (anchorId) {
        const p = findPath(state.clusters, anchorId);
        targetCol = (p && p.c === clusterIdx) ? p.col + 1 : state.clusters[clusterIdx].length;
      } else {
        targetCol = state.clusters[clusterIdx].length;
      }

      const clusters = insertColumnAt(state.clusters, clusterIdx, targetCol, newTile);
      const focusedTileIdByCluster = focus
        ? (() => {
          const next = state.focusedTileIdByCluster.slice();
          next[clusterIdx] = tile.id;
          return next;
        })()
        : state.focusedTileIdByCluster;

      return withDerived({ ...state, clusters, focusedTileIdByCluster });
    }

    case REMOVE_TILE: {
      const { id } = action;
      const path = findPath(state.clusters, id);
      if (!path) return state;

      const prevClusterOrder = clusterOrder(state.clusters[path.c]);
      const removedOrderIdx = prevClusterOrder.indexOf(id);
      const clusters = removeTileAt(state.clusters, path);
      const nextClusterOrder = clusterOrder(clusters[path.c]);

      const focusedTileIdByCluster = state.focusedTileIdByCluster.slice();
      if (focusedTileIdByCluster[path.c] === id) {
        focusedTileIdByCluster[path.c] =
          nextClusterOrder[removedOrderIdx] ||
          nextClusterOrder[removedOrderIdx - 1] ||
          null;
      }

      return withDerived({ ...state, clusters, focusedTileIdByCluster });
    }

    case REORDER: {
      const { order } = action;
      if (!Array.isArray(order)) return state;
      const clusterIdx = typeof action.clusterIdx === "number"
        ? action.clusterIdx
        : state.activeClusterIdx;
      if (clusterIdx < 0 || clusterIdx >= state.clusters.length) return state;

      const cluster = state.clusters[clusterIdx];
      // Build a map from head-tile-id → column (column identity in single-slot
      // is its head tile; multi-slot future will only reorder by head too).
      const byHead = new Map();
      for (const column of cluster) byHead.set(column[0].id, column);

      const seen = new Set();
      const newCluster = [];
      for (const id of order) {
        if (seen.has(id)) continue;
        const col = byHead.get(id);
        if (col) {
          newCluster.push(col);
          seen.add(id);
        }
      }
      // Append any existing columns not mentioned in `order`.
      for (const column of cluster) {
        if (!seen.has(column[0].id)) {
          newCluster.push(column);
          seen.add(column[0].id);
        }
      }

      // No-op if order unchanged.
      let same = newCluster.length === cluster.length;
      if (same) for (let i = 0; i < cluster.length; i++) {
        if (cluster[i] !== newCluster[i]) { same = false; break; }
      }
      if (same) return state;

      const clusters = state.clusters.slice();
      clusters[clusterIdx] = newCluster;
      return withDerived({ ...state, clusters });
    }

    case FOCUS_TILE: {
      const { id } = action;
      if (id === null) {
        const current = state.focusedTileIdByCluster[state.activeClusterIdx];
        if (current === null) return state;
        const focusedTileIdByCluster = state.focusedTileIdByCluster.slice();
        focusedTileIdByCluster[state.activeClusterIdx] = null;
        return withDerived({ ...state, focusedTileIdByCluster });
      }
      const path = findPath(state.clusters, id);
      if (!path) return state;
      // A tile can only be focused within its own cluster. If the caller
      // asks to focus a tile in a non-active cluster, no-op — they need
      // to switchCluster first. Mirrors v2 semantics.
      if (path.c !== state.activeClusterIdx) return state;
      if (state.focusedTileIdByCluster[path.c] === id) return state;
      const focusedTileIdByCluster = state.focusedTileIdByCluster.slice();
      focusedTileIdByCluster[path.c] = id;
      return withDerived({ ...state, focusedTileIdByCluster });
    }

    case UPDATE_PROPS: {
      const { id, patch } = action;
      if (!patch) return state;
      const path = findPath(state.clusters, id);
      if (!path) return state;
      const existing = state.clusters[path.c][path.col][path.row];
      let changed = false;
      for (const k of Object.keys(patch)) {
        if (existing.props[k] !== patch[k]) { changed = true; break; }
      }
      if (!changed) return state;
      const nextTile = { ...existing, props: { ...existing.props, ...patch } };
      const clusters = replaceTileAt(state.clusters, path, nextTile);
      return withDerived({ ...state, clusters });
    }

    case ADD_CLUSTER: {
      const { switchTo = false, position } = action;
      const insertAt = (typeof position === "number"
        && position >= 0
        && position <= state.clusters.length)
        ? position
        : state.clusters.length;

      const clusters = state.clusters.slice();
      clusters.splice(insertAt, 0, []);
      const focusedTileIdByCluster = state.focusedTileIdByCluster.slice();
      focusedTileIdByCluster.splice(insertAt, 0, null);

      let activeClusterIdx = state.activeClusterIdx;
      // Keep the active index pointing at the same cluster the user was
      // looking at — if we inserted at or before it, shift by 1.
      if (insertAt <= activeClusterIdx) activeClusterIdx += 1;
      if (switchTo) activeClusterIdx = insertAt;

      return withDerived({ ...state, clusters, focusedTileIdByCluster, activeClusterIdx });
    }

    case REMOVE_CLUSTER: {
      const { clusterIdx } = action;
      if (typeof clusterIdx !== "number") return state;
      if (clusterIdx < 0 || clusterIdx >= state.clusters.length) return state;
      if (state.clusters.length <= 1) return state; // always keep at least one

      const clusters = state.clusters.slice();
      clusters.splice(clusterIdx, 1);
      const focusedTileIdByCluster = state.focusedTileIdByCluster.slice();
      focusedTileIdByCluster.splice(clusterIdx, 1);

      let activeClusterIdx = state.activeClusterIdx;
      if (activeClusterIdx > clusterIdx) activeClusterIdx -= 1;
      else if (activeClusterIdx === clusterIdx) {
        // Clamp to new bounds; prefer the same position (now the "next" cluster).
        activeClusterIdx = Math.min(activeClusterIdx, clusters.length - 1);
      }

      return withDerived({ ...state, clusters, focusedTileIdByCluster, activeClusterIdx });
    }

    case SWITCH_CLUSTER: {
      const { clusterIdx } = action;
      if (typeof clusterIdx !== "number") return state;
      if (clusterIdx < 0 || clusterIdx >= state.clusters.length) return state;
      if (state.activeClusterIdx === clusterIdx) return state;
      return withDerived({ ...state, activeClusterIdx: clusterIdx });
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
 * Coerce an arbitrary object into a valid v3 state.
 *
 * Accepts:
 *   - v3: passed through (after structural validation).
 *   - v2: tiles grouped by clusterId + x into single-slot columns.
 *   - v1: flat order → single cluster, single-slot columns.
 *   - null / invalid → EMPTY_STATE.
 */
export function normalize(raw) {
  if (!raw || typeof raw !== "object") return EMPTY_STATE;

  // v3: already in the target shape.
  if (raw.version === 3 && Array.isArray(raw.clusters)) {
    return normalizeV3(raw);
  }

  // v2: tiles are a map with clusterId + x.
  if (typeof raw.activeClusterId === "string" && raw.clusters && typeof raw.clusters === "object") {
    return migrateV2(raw);
  }

  // v1: a map of tiles, plus a flat order array.
  if (raw.tiles && typeof raw.tiles === "object") {
    return migrateV1(raw);
  }

  return EMPTY_STATE;
}

function normalizeV3(raw) {
  // Validate 3D array + drop malformed tiles. Unknown fields on tiles are
  // stripped to keep persistence canonical ({id, type, props} only).
  const seenIds = new Set();
  const clusters = [];
  for (const cluster of raw.clusters) {
    if (!Array.isArray(cluster)) { clusters.push([]); continue; }
    const cleanCluster = [];
    for (const column of cluster) {
      if (!Array.isArray(column) || column.length === 0) continue;
      const cleanColumn = [];
      for (const tile of column) {
        if (!tile || typeof tile.id !== "string" || typeof tile.type !== "string") continue;
        if (RESERVED_IDS.has(tile.id)) continue;
        if (seenIds.has(tile.id)) continue;
        seenIds.add(tile.id);
        cleanColumn.push({ id: tile.id, type: tile.type, props: { ...(tile.props || {}) } });
      }
      if (cleanColumn.length > 0) cleanCluster.push(cleanColumn);
    }
    clusters.push(cleanCluster);
  }
  if (clusters.length === 0) clusters.push([]);

  const focusedTileIdByCluster = [];
  for (let c = 0; c < clusters.length; c++) {
    const rawFocusedId = Array.isArray(raw.focusedTileIdByCluster)
      ? raw.focusedTileIdByCluster[c]
      : null;
    const inCluster = rawFocusedId && clusters[c].some(col => col.some(t => t.id === rawFocusedId));
    focusedTileIdByCluster.push(inCluster ? rawFocusedId : (clusters[c][0]?.[0]?.id ?? null));
  }

  let activeClusterIdx = typeof raw.activeClusterIdx === "number" ? raw.activeClusterIdx : 0;
  if (activeClusterIdx < 0 || activeClusterIdx >= clusters.length) activeClusterIdx = 0;

  return withDerived({
    version: VERSION,
    clusters,
    activeClusterIdx,
    focusedTileIdByCluster,
    tiles: {},
    order: [],
    focusedId: null,
  });
}

function migrateV2(raw) {
  // Collect cluster ids in a stable order: active cluster first, then the
  // rest by insertion order of raw.clusters. This keeps the active cluster
  // at activeClusterIdx=0 by default if nothing else pins it.
  const clusterIds = [];
  if (raw.clusters[raw.activeClusterId]) clusterIds.push(raw.activeClusterId);
  for (const id of Object.keys(raw.clusters)) {
    if (!clusterIds.includes(id)) clusterIds.push(id);
  }
  if (clusterIds.length === 0) clusterIds.push("default");

  const clusters = [];
  const focusedTileIdByCluster = [];
  const seenIds = new Set();

  for (const cid of clusterIds) {
    // Tiles in this cluster, sorted by x ascending.
    const tiles = Object.values(raw.tiles || {})
      .filter(t => t && typeof t.type === "string" && t.clusterId === cid)
      .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    const cleaned = [];
    for (const t of tiles) {
      if (RESERVED_IDS.has(t.id)) continue;
      if (seenIds.has(t.id)) continue;
      seenIds.add(t.id);
      cleaned.push([{ id: t.id, type: t.type, props: { ...(t.props || {}) } }]);
    }
    clusters.push(cleaned);

    const rawFocusedId = raw.focusedIdByCluster?.[cid];
    const inCluster = rawFocusedId && cleaned.some(col => col[0].id === rawFocusedId);
    focusedTileIdByCluster.push(inCluster ? rawFocusedId : (cleaned[0]?.[0]?.id ?? null));
  }

  const activeClusterIdx = Math.max(0, clusterIds.indexOf(raw.activeClusterId));

  return withDerived({
    version: VERSION,
    clusters,
    activeClusterIdx,
    focusedTileIdByCluster,
    tiles: {},
    order: [],
    focusedId: null,
  });
}

function migrateV1(raw) {
  const order = Array.isArray(raw.order) ? raw.order : Object.keys(raw.tiles);
  const seenIds = new Set();
  const cluster = [];
  for (const id of order) {
    const t = raw.tiles[id];
    if (!t || typeof t.type !== "string") continue;
    if (RESERVED_IDS.has(id)) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    cluster.push([{ id, type: t.type, props: { ...(t.props || {}) } }]);
  }
  // Include tiles that weren't in raw.order.
  for (const [id, t] of Object.entries(raw.tiles)) {
    if (RESERVED_IDS.has(id)) continue;
    if (seenIds.has(id)) continue;
    if (!t || typeof t.type !== "string") continue;
    cluster.push([{ id, type: t.type, props: { ...(t.props || {}) } }]);
  }

  const focusedRaw = typeof raw.focusedId === "string" ? raw.focusedId : null;
  const focused = cluster.some(col => col[0].id === focusedRaw)
    ? focusedRaw
    : (cluster[0]?.[0]?.id ?? null);

  return withDerived({
    version: VERSION,
    clusters: [cluster],
    activeClusterIdx: 0,
    focusedTileIdByCluster: [focused],
    tiles: {},
    order: [],
    focusedId: null,
  });
}

// ─── Persistence ─────────────────────────────────────────────────────
/**
 * Serialize state for localStorage. Derived fields (tiles, order, focusedId)
 * are NOT written — they're re-derived on normalize. Non-persistable tiles
 * are stripped per the caller-provided predicate.
 */
export function serialize(state, isPersistable = () => true) {
  const clusters = [];
  const seenIds = new Set();
  for (const cluster of state.clusters) {
    const cleanCluster = [];
    for (const column of cluster) {
      const cleanColumn = [];
      for (const tile of column) {
        if (!isPersistable(tile.type, tile.props || {})) continue;
        if (seenIds.has(tile.id)) continue;
        seenIds.add(tile.id);
        cleanColumn.push(tile);
      }
      if (cleanColumn.length > 0) cleanCluster.push(cleanColumn);
    }
    clusters.push(cleanCluster);
  }

  const focusedTileIdByCluster = [];
  for (let c = 0; c < clusters.length; c++) {
    const f = state.focusedTileIdByCluster[c];
    const inCluster = f && clusters[c].some(col => col.some(t => t.id === f));
    focusedTileIdByCluster.push(inCluster ? f : null);
  }

  let activeClusterIdx = state.activeClusterIdx;
  if (activeClusterIdx < 0 || activeClusterIdx >= clusters.length) activeClusterIdx = 0;

  return {
    version: VERSION,
    clusters,
    activeClusterIdx,
    focusedTileIdByCluster,
  };
}

export function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed) return null;
    // Accept v1, v2, and v3 shapes — normalize handles all three.
    if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== VERSION) return null;
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
    addCluster:    (opts = {})       => store.dispatch({ type: ADD_CLUSTER, ...opts }),
    removeCluster: (clusterIdx)      => store.dispatch({ type: REMOVE_CLUSTER, clusterIdx }),
    switchCluster: (clusterIdx)      => store.dispatch({ type: SWITCH_CLUSTER, clusterIdx }),
  };
}
