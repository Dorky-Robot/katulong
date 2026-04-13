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
