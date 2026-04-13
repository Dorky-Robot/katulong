/**
 * Navigation — pure functions for tile tab navigation.
 *
 * Each function takes ui-store state and returns an action object
 * (or null if the navigation is a no-op). The caller dispatches
 * the action to the store; side effects (WS bookkeeping, URL sync)
 * flow from store subscriptions.
 *
 * Pure: (uiState, ...args) => action | null.
 */

import { FOCUS_TILE, REORDER } from "./ui-store.js";

/**
 * Navigate to the next/previous tile in order.
 * direction: +1 (right/next) or -1 (left/previous). Wraps around.
 *
 * @param {object} uiState — from uiStore.getState()
 * @param {number} direction — +1 or -1
 * @returns {{ type: string, id: string } | null}
 */
export function navigateTab(uiState, direction) {
  const { order, focusedId } = uiState;
  if (order.length <= 1) return null;
  const idx = order.indexOf(focusedId);
  if (idx === -1) return null;
  const nextId = order[(idx + direction + order.length) % order.length];
  if (nextId === focusedId) return null;
  return { type: FOCUS_TILE, id: nextId };
}

/**
 * Move the focused tile one position in the given direction.
 * Does not wrap — stops at edges.
 *
 * @param {object} uiState
 * @param {number} direction — +1 or -1
 * @returns {{ type: string, order: string[] } | null}
 */
export function moveTab(uiState, direction) {
  const { order, focusedId } = uiState;
  if (order.length <= 1) return null;
  const idx = order.indexOf(focusedId);
  if (idx === -1) return null;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= order.length) return null;
  const reordered = [...order];
  [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
  return { type: REORDER, order: reordered };
}

/**
 * Jump to the tile at a 1-based position (Option+1 = first tile, etc.).
 * No-ops if the position is out of range or already focused.
 *
 * @param {object} uiState
 * @param {number} position — 1-based index
 * @returns {{ type: string, id: string } | null}
 */
export function jumpToTab(uiState, position) {
  const { order, focusedId } = uiState;
  const idx = position - 1;
  if (idx < 0 || idx >= order.length) return null;
  const targetId = order[idx];
  if (targetId === focusedId) return null;
  return { type: FOCUS_TILE, id: targetId };
}
