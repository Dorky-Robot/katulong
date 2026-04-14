/**
 * Boot-state composition — pure function that builds the initial
 * ui-store state from all the sources the app needs at launch.
 *
 * Moved out of app.js to make it testable without a DOM, and so the
 * multi-cluster schema bump (FP1) has a single, reviewed place where
 * persistence + URL hints + window tabsets meet.
 *
 * Sources, in priority order:
 *   1. `persisted`       — result of ui-store `loadFromStorage()`.
 *   2. `legacyCarousel`  — shape the pre-ui-store carousel persisted
 *                          (`{ tiles: [...], focused }`). Only used
 *                          when `persisted` is empty/missing, and
 *                          signals `migratedLegacy: true` so the
 *                          caller can clear the old storage key.
 *   3. `urlSession`      — the `?s=<name>` hint. Adds a new terminal
 *                          tile if the session isn't already present
 *                          and focuses it.
 *   4. `tabSetSessions`  — legacy windowTabSet sessions. Folds in any
 *                          terminals that other windows know about
 *                          but weren't persisted here yet.
 */

import { EMPTY_STATE, normalize, DEFAULT_CLUSTER_ID } from "./ui-store.js";

/**
 * @param {object} deps
 * @param {object|null} [deps.persisted]         Normalized v2 state or null.
 * @param {object|null} [deps.legacyCarousel]    Pre-ui-store carousel state or null.
 * @param {string|null} [deps.urlSession]        Value of ?s= URL param.
 * @param {string[]}    [deps.tabSetSessions]    Window tab-set session names.
 * @param {function}    [deps.getRenderer]       Renderer lookup (type -> renderer|null).
 *                                               Legacy tiles with unknown types are dropped.
 * @returns {{ state: object, migratedLegacy: boolean }}
 */
export function buildBootState({
  persisted = null,
  legacyCarousel = null,
  urlSession = null,
  tabSetSessions = [],
  getRenderer = () => ({}),
} = {}) {
  let state = persisted && Object.keys(persisted.tiles || {}).length > 0
    ? persisted
    : null;
  let migratedLegacy = false;

  if (!state && legacyCarousel?.tiles?.length) {
    const tiles = {};
    for (const t of legacyCarousel.tiles) {
      const type = t.type === "dashboard" ? "cluster" : t.type;
      if (!getRenderer(type)) continue;
      const { id, type: _t, cardWidth: _cw, ...rest } = t;
      tiles[t.id] = { id: t.id, type, props: rest, clusterId: DEFAULT_CLUSTER_ID };
    }
    if (Object.keys(tiles).length > 0) {
      // Assign x from the order of the legacy array.
      let x = 0;
      for (const t of legacyCarousel.tiles) {
        if (tiles[t.id]) tiles[t.id].x = x++;
      }
      state = normalize({
        version: 2,
        activeClusterId: DEFAULT_CLUSTER_ID,
        clusters: { [DEFAULT_CLUSTER_ID]: { id: DEFAULT_CLUSTER_ID } },
        tiles,
        focusedIdByCluster: {
          [DEFAULT_CLUSTER_ID]: legacyCarousel.focused || null,
        },
      });
      migratedLegacy = true;
    }
  }

  if (!state) state = EMPTY_STATE;

  // ── Merge ?s= URL hint ──────────────────────────────────────────
  // Only override focusedId when the URL actually introduces a NEW
  // session. Otherwise the persisted focusedId wins — ?s= only tracks
  // terminals and goes stale when the user focuses a non-terminal
  // tile (e.g. file browser).
  if (urlSession) {
    if (!state.tiles[urlSession]) {
      state = mergeTile(state, {
        id: urlSession,
        type: "terminal",
        props: { sessionName: urlSession },
        clusterId: state.activeClusterId,
      }, { focus: true });
    }
  }

  // ── Merge windowTabSet sessions ─────────────────────────────────
  for (const name of tabSetSessions) {
    if (!state.tiles[name]) {
      state = mergeTile(state, {
        id: name,
        type: "terminal",
        props: { sessionName: name },
        clusterId: state.activeClusterId,
      }, { focus: false });
    }
  }

  return { state, migratedLegacy };
}

/**
 * Add a tile to a v2 state (pure — returns a new state). Keeps the
 * boot-state composition isolated from the reducer so it doesn't need
 * a live store to compose initial state.
 */
function mergeTile(state, tile, { focus = false } = {}) {
  const { clusterId } = tile;
  // nextX within the tile's cluster.
  let maxX = -1;
  for (const t of Object.values(state.tiles)) {
    if (t.clusterId === clusterId && typeof t.x === "number" && t.x > maxX) maxX = t.x;
  }
  const nextTile = { ...tile, x: maxX + 1 };
  const tiles = { ...state.tiles, [tile.id]: nextTile };
  const focusedIdByCluster = focus
    ? { ...state.focusedIdByCluster, [clusterId]: tile.id }
    : state.focusedIdByCluster;
  return normalize({
    ...state,
    tiles,
    focusedIdByCluster,
  });
}
