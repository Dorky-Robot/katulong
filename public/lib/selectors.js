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

/** The ID of the currently focused tile, or null. */
export const getFocusedTileId = (uiState) => uiState.focusedId;

/** The full tile object { id, type, props, x } for the focused tile, or null. */
export const getFocusedTile = (uiState) =>
  uiState.tiles[uiState.focusedId] || null;

/** The type string of the focused tile (e.g. "terminal", "feed"), or null. */
export const getFocusedTileType = (uiState) =>
  uiState.tiles[uiState.focusedId]?.type || null;

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
 * The tmux session name for any tile by ID, or null.
 *
 * @param {object} uiState
 * @param {string} tileId
 * @param {function} getRenderer
 * @returns {string|null}
 */
export function getTileSession(uiState, tileId, getRenderer) {
  const tile = uiState.tiles[tileId];
  if (!tile) return null;
  const renderer = getRenderer(tile.type);
  if (!renderer) return null;
  return renderer.describe(tile.props).session || null;
}

/**
 * Whether the focused tile needs a WebSocket connection (has a session).
 *
 * @param {object} uiState
 * @param {function} getRenderer
 * @returns {boolean}
 */
export function focusedTileNeedsWs(uiState, getRenderer) {
  return getFocusedSession(uiState, getRenderer) !== null;
}
