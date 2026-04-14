/**
 * Selectors — pure functions that derive values from store state.
 *
 * v3: clusters are stored as a 3D array `Tile[][][]` where position IS
 * location. These selectors project views out of that shape for consumers
 * that want map-access, a flat order, or the 2D per-cluster column view.
 *
 * Every function here is pure: `(state, ...deps) => value`.
 */

/**
 * The tmux session name for the focused tile, or null.
 *
 * Only terminal and cluster tiles have a session — feed, file-browser,
 * localhost-browser, and progress tiles return null. Callers that need
 * to send WS messages should use this selector and guard against null.
 *
 * @param {object} uiState — from uiStore.getState()
 * @param {function} getRenderer — from tile-renderers/index.js
 * @returns {string|null}
 */
export function getFocusedSession(uiState, getRenderer) {
  const tile = uiState.tiles[uiState.focusedId];
  if (!tile) return null;
  const renderer = getRenderer(tile.type);
  if (!renderer) return null;
  return renderer.describe(tile.props).session || null;
}

/**
 * Cluster-scoped view of ui-store state.
 *
 * Returns a `{ tiles, order, focusedId }` triple filtered to a single
 * cluster, column-major top→bottom. Used by tile-host and WS-subscription
 * code so each cluster can drive its own carousel and bookkeep its own
 * session subscriptions independently.
 *
 * Pure: no dependency on renderer registry, no mutation of input. Given
 * an out-of-range cluster index, returns an empty view.
 *
 * @param {object} uiState
 * @param {number} clusterIdx
 * @returns {{ tiles: object, order: string[], focusedId: string|null }}
 */
export function selectClusterView(uiState, clusterIdx) {
  const cluster = uiState?.clusters?.[clusterIdx];
  if (!cluster) return { tiles: {}, order: [], focusedId: null };

  const tiles = {};
  const order = [];
  for (const column of cluster) {
    for (const tile of column) {
      tiles[tile.id] = tile;
      order.push(tile.id);
    }
  }
  const focusedId = uiState.focusedTileIdByCluster?.[clusterIdx] ?? null;
  return { tiles, order, focusedId };
}

/**
 * 2D column view of a cluster, for Level-2 rendering and future drag-to-stack.
 *
 * Each column is identified by its head tile id (there is no separate
 * "column id" entity — columns don't persist identity beyond their tiles).
 * In MC1 single-slot, every column has length 1 so `id === tileIds[0]`.
 *
 * @param {object} uiState
 * @param {number} clusterIdx
 * @returns {{ id: string, tileIds: string[] }[]}
 */
export function selectColumns(uiState, clusterIdx) {
  const cluster = uiState?.clusters?.[clusterIdx];
  if (!cluster) return [];
  return cluster.map((column) => ({
    id: column[0].id,
    tileIds: column.map(t => t.id),
  }));
}

/**
 * Build an O(1) tile-id → path locator for the whole workspace.
 *
 * With tiles stored positionally in a 3D array, finding a tile by id
 * requires a traversal. This selector memoizes the index per state
 * reference via WeakMap so repeated lookups (e.g., from WS message
 * handlers, focus moves) are free.
 *
 * @param {object} uiState
 * @returns {{
 *   get: (id: string) => { c: number, col: number, row: number, tile: object } | null,
 *   has: (id: string) => boolean,
 *   ids: () => string[],
 *   size: () => number,
 * }}
 */
const _locatorCache = new WeakMap();
const EMPTY_LOCATOR = Object.freeze({
  get: () => null,
  has: () => false,
  ids: () => [],
  size: () => 0,
});

export function tileLocator(uiState) {
  if (!uiState || !Array.isArray(uiState.clusters)) return EMPTY_LOCATOR;
  const cached = _locatorCache.get(uiState);
  if (cached) return cached;

  const index = new Map();
  for (let c = 0; c < uiState.clusters.length; c++) {
    const cluster = uiState.clusters[c];
    for (let col = 0; col < cluster.length; col++) {
      const column = cluster[col];
      for (let row = 0; row < column.length; row++) {
        const tile = column[row];
        index.set(tile.id, { c, col, row, tile });
      }
    }
  }

  const locator = {
    get: (id) => index.get(id) || null,
    has: (id) => index.has(id),
    ids: () => [...index.keys()],
    size: () => index.size,
  };
  _locatorCache.set(uiState, locator);
  return locator;
}
