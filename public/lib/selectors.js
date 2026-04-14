/**
 * Selectors — pure functions that derive values from store state.
 *
 * These replace the mutable `state.session.name` pattern. Instead of
 * storing the "current session" as a side-effected variable, we derive
 * it on-demand from the ui-store's focusedId and the renderer registry.
 *
 * Every function here is pure: (state, ...deps) => value.
 * No side effects, no mutations, no subscriptions.
 */

/**
 * The tmux session name for the focused tile, or null.
 *
 * Only terminal and cluster tiles have a session — feed, file-browser,
 * localhost-browser, and progress tiles return null. Callers that need
 * to send WS messages (attach, switch, resize, subscribe) should use
 * this selector and guard against null.
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
 * cluster. Used by tile-host and WS-subscription code so each cluster
 * can drive its own carousel and bookkeep its own session subscriptions
 * independently.
 *
 * Pure: no dependency on renderer registry, no mutation of input. Given
 * an unknown or missing cluster id, returns an empty view.
 *
 * @param {object} uiState
 * @param {string} clusterId
 * @returns {{ tiles: object, order: string[], focusedId: string|null }}
 */
export function selectClusterView(uiState, clusterId) {
  if (!uiState?.clusters?.[clusterId]) {
    return { tiles: {}, order: [], focusedId: null };
  }
  const tiles = {};
  const arr = [];
  for (const t of Object.values(uiState.tiles)) {
    if (t.clusterId !== clusterId) continue;
    tiles[t.id] = t;
    arr.push(t);
  }
  arr.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
  const order = arr.map(t => t.id);
  const focusedId = uiState.focusedIdByCluster?.[clusterId] ?? null;
  return { tiles, order, focusedId };
}
