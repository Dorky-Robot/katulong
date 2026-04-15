/**
 * Level-2 cluster strips — vertical stack of horizontal strips, one per
 * cluster. Pinch-out from L1 surfaces this view; tap a cluster (or
 * pinch-in) returns to L1 on that cluster.
 *
 * This is a *projection* of uiStore state: it reads `clusters`,
 * `activeClusterIdx`, `focusedTileIdByCluster`, and `level`; it never
 * owns cluster topology. Interactions dispatch through the store
 * (`switchCluster`, `setLevel`, `addCluster`, `focusTile`).
 *
 * Scope (MVP):
 *   - Render every cluster as a row of lightweight tile previews.
 *     Preview shape is driven by `getTileLabel(tile)` — the host supplies
 *     labels so this module doesn't learn tile-type semantics.
 *   - Active cluster's strip is marked visually so the user can orient.
 *   - Tap cluster or any preview → switch cluster + return to L1.
 *     Tapping a specific preview also focuses that tile.
 *   - `+` at the bottom creates a new empty cluster and stays at L2 so the
 *     new strip is visible. Switching happens when the user taps it.
 *
 * Not in scope (deferred):
 *   - Axonometric tilted decks for multi-row columns. Columns are
 *     single-row today (no drag-to-stack yet), so the MVP renders each
 *     column as a flat card. When multi-row columns land, extend the
 *     per-column render path here — the strip container is already the
 *     right seam.
 *   - Animated L1↔L2 morph of the same tile DOM. The live terminal DOM
 *     stays mounted in #terminal-container (just visually hidden under
 *     the L2 overlay), so terminals don't lose state. A future pass can
 *     animate the handoff without changing this module's API.
 */

const EL_ID = "cluster-strips";

export function createClusterStrips({ store, mountIn, getTileLabel }) {
  if (!store || !mountIn) {
    throw new Error("createClusterStrips: store and mountIn required");
  }
  const labelFor = typeof getTileLabel === "function" ? getTileLabel : defaultLabel;

  const root = document.createElement("div");
  root.id = EL_ID;
  root.hidden = true;
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Cluster overview");

  const stripsEl = document.createElement("div");
  stripsEl.className = "cs-strips";
  root.appendChild(stripsEl);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "cs-add-cluster";
  addBtn.textContent = "+ New cluster";
  addBtn.setAttribute("aria-label", "Add new cluster");
  addBtn.addEventListener("click", () => {
    store.addCluster({ switchTo: false });
  });
  root.appendChild(addBtn);

  // Click delegation — a single listener on the strips container handles
  // taps on any strip or preview. Cheaper than per-preview listeners and
  // survives re-rendering without needing to re-wire.
  stripsEl.addEventListener("click", (e) => {
    const tileEl = e.target.closest("[data-tile-id]");
    const stripEl = e.target.closest("[data-cluster-idx]");
    if (!stripEl) return;
    const idx = Number(stripEl.getAttribute("data-cluster-idx"));
    if (Number.isNaN(idx)) return;
    if (tileEl) {
      const id = tileEl.getAttribute("data-tile-id");
      store.switchCluster(idx);
      store.focusTile(id);
    } else {
      store.switchCluster(idx);
    }
    store.setLevel(1);
  });

  mountIn.appendChild(root);

  let lastClusters = null;
  let lastActive = -1;
  let lastFocused = null;
  let lastLevel = 1;

  function render(state) {
    const levelChanged = state.level !== lastLevel;
    lastLevel = state.level;
    root.hidden = state.level !== 2;
    // Hide the sibling L1 surface so the overlay has the whole stage.
    // We set an attribute on the document root so any surface can react
    // (shortcut bar, joystick) without each needing to subscribe.
    document.documentElement.setAttribute("data-ui-level", String(state.level));
    if (root.hidden) return;

    // Short-circuit re-renders when the topology the strips depend on
    // hasn't changed. `clusters` is structurally shared by uiStore, so
    // reference equality is sound.
    const topologySame =
      state.clusters === lastClusters &&
      state.activeClusterIdx === lastActive &&
      state.focusedTileIdByCluster[state.activeClusterIdx] === lastFocused &&
      !levelChanged;
    if (topologySame) return;

    lastClusters = state.clusters;
    lastActive = state.activeClusterIdx;
    lastFocused = state.focusedTileIdByCluster[state.activeClusterIdx] ?? null;

    stripsEl.textContent = "";
    for (let c = 0; c < state.clusters.length; c++) {
      stripsEl.appendChild(buildStrip(state, c, labelFor));
    }
  }

  render(store.getState());
  const unsub = store.subscribe(render);

  return {
    element: root,
    destroy() {
      unsub();
      root.remove();
      document.documentElement.removeAttribute("data-ui-level");
    },
  };
}

function buildStrip(state, clusterIdx, labelFor) {
  const cluster = state.clusters[clusterIdx];
  const isActive = clusterIdx === state.activeClusterIdx;
  const focusedInCluster = state.focusedTileIdByCluster[clusterIdx] ?? null;

  const strip = document.createElement("div");
  strip.className = "cs-strip";
  strip.setAttribute("data-cluster-idx", String(clusterIdx));
  if (isActive) strip.setAttribute("data-active", "true");
  strip.setAttribute("role", "listitem");
  strip.setAttribute("aria-label", `Cluster ${clusterIdx + 1}${isActive ? " (current)" : ""}`);

  const label = document.createElement("div");
  label.className = "cs-strip-label";
  label.textContent = `Cluster ${clusterIdx + 1}${isActive ? " · current" : ""}`;
  strip.appendChild(label);

  const row = document.createElement("div");
  row.className = "cs-strip-row";
  strip.appendChild(row);

  if (cluster.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cs-strip-empty";
    empty.textContent = "empty";
    row.appendChild(empty);
    return strip;
  }

  for (const column of cluster) {
    // Single-row columns today render as a flat card. When multi-row
    // columns land (drag-to-stack), this is the seam where the tilted
    // deck render takes over — keep the per-column loop isolated.
    const col = document.createElement("div");
    col.className = "cs-column";
    if (column.length > 1) col.setAttribute("data-stacked", String(column.length));
    for (const tile of column) {
      const card = document.createElement("div");
      card.className = "cs-card";
      card.setAttribute("data-tile-id", tile.id);
      card.setAttribute("data-tile-type", tile.type);
      if (tile.id === focusedInCluster) card.setAttribute("data-focused", "true");
      card.textContent = labelFor(tile);
      col.appendChild(card);
    }
    row.appendChild(col);
  }
  return strip;
}

function defaultLabel(tile) {
  if (!tile) return "";
  if (tile.props) {
    if (typeof tile.props.sessionName === "string") return tile.props.sessionName;
    if (typeof tile.props.title === "string") return tile.props.title;
    if (typeof tile.props.topic === "string") return tile.props.topic;
  }
  return tile.type || tile.id;
}
