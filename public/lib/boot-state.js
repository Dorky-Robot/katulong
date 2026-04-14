/**
 * Boot-state composition — pure function that builds the initial
 * ui-store state from all the sources the app needs at launch.
 *
 * Moved out of app.js to make it testable without a DOM, and so the
 * multi-cluster schema bump has a single, reviewed place where
 * persistence + URL hints + window tabsets meet.
 *
 * Sources, in priority order:
 *   1. `persisted`       — result of ui-store `loadFromStorage()` (already v3-normalized).
 *   2. `legacyCarousel`  — shape the pre-ui-store carousel persisted
 *                          (`{ tiles: [...], focused }`). Only used
 *                          when `persisted` is empty/missing, and
 *                          signals `migratedLegacy: true` so the
 *                          caller can clear the old storage key.
 *   3. `urlSession`      — the `?s=<name>` hint. Adds a new terminal
 *                          tile to the active cluster if missing and
 *                          focuses it.
 *   4. `tabSetSessions`  — legacy windowTabSet sessions. Folds in any
 *                          terminals that other windows know about
 *                          but weren't persisted here yet.
 */

import { EMPTY_STATE, normalize } from "./ui-store.js";

/**
 * @param {object} deps
 * @param {object|null} [deps.persisted]         Normalized v3 state or null.
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
  const hasPersistedTiles = persisted
    && Array.isArray(persisted.clusters)
    && persisted.clusters.some(cluster => cluster.length > 0);

  let state = hasPersistedTiles ? persisted : null;
  let migratedLegacy = false;

  if (!state && legacyCarousel?.tiles?.length) {
    const cluster = [];
    for (const t of legacyCarousel.tiles) {
      const type = t.type === "dashboard" ? "cluster" : t.type;
      if (!getRenderer(type)) continue;
      const { id, type: _t, cardWidth: _cw, ...rest } = t;
      cluster.push([{ id, type, props: rest }]);
    }
    if (cluster.length > 0) {
      const focusedRaw = legacyCarousel.focused;
      const focused = cluster.some(col => col[0].id === focusedRaw)
        ? focusedRaw
        : cluster[0][0].id;
      state = normalize({
        version: 3,
        clusters: [cluster],
        activeClusterIdx: 0,
        focusedTileIdByCluster: [focused],
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
  if (urlSession && !state.tiles[urlSession]) {
    state = appendTerminalTile(state, urlSession, { focus: true });
  }

  // ── Merge windowTabSet sessions ─────────────────────────────────
  for (const name of tabSetSessions) {
    if (!state.tiles[name]) {
      state = appendTerminalTile(state, name, { focus: false });
    }
  }

  return { state, migratedLegacy };
}

/**
 * Append a terminal tile as a new single-slot column at the end of the
 * active cluster. Pure — returns a new state. Used for URL/tabset merge
 * during boot only; runtime adds go through the reducer.
 */
function appendTerminalTile(state, sessionName, { focus = false } = {}) {
  const c = state.activeClusterIdx;
  const newCluster = state.clusters[c].slice();
  newCluster.push([{
    id: sessionName,
    type: "terminal",
    props: { sessionName },
  }]);
  const clusters = state.clusters.slice();
  clusters[c] = newCluster;

  const focusedTileIdByCluster = focus
    ? (() => {
      const next = state.focusedTileIdByCluster.slice();
      next[c] = sessionName;
      return next;
    })()
    : state.focusedTileIdByCluster;

  return normalize({
    version: 3,
    clusters,
    activeClusterIdx: c,
    focusedTileIdByCluster,
  });
}
