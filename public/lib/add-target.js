/**
 * `+` button routing — pure decision + factory.
 *
 * The + button has two distinct behaviors depending on zoom level:
 *   - Level 1 (focused cluster, default):  add a tile to the active cluster
 *   - Level 2 (cluster overview):          add a new empty cluster
 *
 * FP3 in the multi-cluster FP pre-req chain. Goal is to shift add-routing
 * load from integration tests onto pure unit tests — `decideAddTarget()`
 * has zero I/O and can cover every branch in a handful of asserts.
 *
 * The factory (`createAddHandler`) wires the pure decision into a handler
 * that sidebar-+, tab-add, and (future) Level-2-+ all share. Side effects
 * (API calls, store dispatch) stay on the caller via injected `onAddTile`
 * / `onAddCluster` — the factory never touches the outside world.
 */

/**
 * @typedef {{ kind: "tile", clusterId: string, insertAfter: string | null }} TileTarget
 * @typedef {{ kind: "cluster" }} ClusterTarget
 * @typedef {TileTarget | ClusterTarget} AddTarget
 */

/**
 * Decide what the + button should produce, given zoom level and state.
 *
 * @param {object} ctx
 * @param {number} ctx.level           Current zoom level (1 = focused, 2 = overview).
 * @param {string} ctx.activeClusterId Id of the currently-active cluster.
 * @param {string|null} [ctx.focusedId] Focused tile id, if any.
 * @returns {AddTarget}
 */
export function decideAddTarget({ level, activeClusterId, focusedId = null }) {
  if (level >= 2) return { kind: "cluster" };
  return {
    kind: "tile",
    clusterId: activeClusterId,
    insertAfter: focusedId,
  };
}

/**
 * Unique session id. Pure given a clock; defaults to Date.now.
 * Kept here so the callers (sidebar-+, menu) share one format.
 *
 * @param {() => number} [now]
 */
export function generateSessionName(now = Date.now) {
  return `session-${now().toString(36)}`;
}

/**
 * Unique cluster id. Same shape as generateSessionName so future
 * migration code can recognize "generated" ids vs. hand-named ones.
 *
 * @param {() => number} [now]
 */
export function generateClusterId(now = Date.now) {
  return `cluster-${now().toString(36)}`;
}

/**
 * Factory for a unified + handler. Both Level 1 and Level 2 add-buttons
 * call the returned function with no args; it reads fresh state, asks
 * `decideAddTarget` what to do, and dispatches to the right effect.
 *
 * The separation matters for testability: every branch is covered by
 * driving fake `getLevel`/`getState` into the factory and asserting on
 * the injected `onAddTile`/`onAddCluster` spies.
 *
 * @param {object} deps
 * @param {() => number} deps.getLevel
 * @param {() => { activeClusterId: string, focusedId: string|null }} deps.getState
 * @param {(target: TileTarget) => any} deps.onAddTile
 * @param {(target: ClusterTarget) => any} deps.onAddCluster
 * @returns {() => any} handleAdd
 */
export function createAddHandler({ getLevel, getState, onAddTile, onAddCluster }) {
  return function handleAdd() {
    const { activeClusterId, focusedId } = getState();
    const target = decideAddTarget({
      level: getLevel(),
      activeClusterId,
      focusedId,
    });
    if (target.kind === "cluster") return onAddCluster(target);
    return onAddTile(target);
  };
}
