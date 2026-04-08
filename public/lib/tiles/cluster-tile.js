/**
 * Terminal Cluster Tile
 *
 * A single card that hosts a grid of independent mini terminals. Each
 * cell is its own tmux session with its own PTY — they are *not* views
 * onto the same shell. Splitting into separate PTYs is the whole point:
 * a PTY has exactly one size, so two devices can't render the same pane
 * at different widths. Clusters let katulong give each rendering slot
 * its own dimensions while keeping the grid layout on one card.
 *
 * See `docs/cluster-state-machine.md` for the formal lifecycle spec.
 *
 * Usage:
 *   createClusterTile({
 *     cols: 2,
 *     rows: 2,
 *     title: "katulong dev",
 *     slots: [
 *       { sessionName: "dev" },
 *       { sessionName: "test" },
 *       { sessionName: "logs" },
 *       { sessionName: "repl" },
 *     ],
 *   })
 *
 * Shorthand — pass `cells` to auto-compute a grid:
 *   createClusterTile({ cells: 4, slots: [...] })
 *   // → 2x2 (auto-layout picks the squarest arrangement)
 */

/**
 * Auto-compute cols × rows for a given cell count. Picks the squarest
 * arrangement, favoring wider over taller.
 */
function autoGrid(cells) {
  const cols = Math.ceil(Math.sqrt(cells));
  const rows = Math.ceil(cells / cols);
  return { cols, rows };
}

/**
 * Create the cluster tile factory.
 *
 * Unlike the old dashboard-tile factory, this one takes a single
 * `createTerminalTile` dep — there is no type dispatch. Every slot
 * in a cluster is a terminal tile. Heterogeneous grids were a plugin-SDK
 * concern and were removed with the rest of the tile plugin surface.
 *
 * @param {object} deps
 * @param {(options: object) => TilePrototype} deps.createTerminalTile
 * @returns {(options: object) => TilePrototype}
 */
export function createClusterTileFactory({ createTerminalTile }) {
  /**
   * @param {object} options
   * @param {number} [options.cols] — number of columns
   * @param {number} [options.rows] — number of rows
   * @param {number} [options.cells] — total cells (auto-computes cols/rows)
   * @param {string} [options.maxCellWidth] — CSS max-width per column (e.g. "400px")
   * @param {number} [options.gap=8] — gap between cells in px
   * @param {string} [options.title] — custom cluster title
   * @param {Array<{sessionName: string, colSpan?: number, rowSpan?: number}>} options.slots
   */
  return function createClusterTile(options = {}) {
    let {
      cols,
      rows,
      cells,
      maxCellWidth,
      gap = 8,
      title,
      slots = [],
    } = options;

    // Resolve grid dimensions
    if (!cols && !rows) {
      const count = cells || slots.length || 1;
      const auto = autoGrid(count);
      cols = auto.cols;
      rows = auto.rows;
    } else {
      cols = cols || 1;
      rows = rows || Math.ceil((slots.length || 1) / cols);
    }

    let container = null;
    let gridEl = null;
    let parentContext = null;
    const subTiles = []; // Array<{ tile, wrapper, index, slot }>

    return {
      type: "cluster",

      /**
       * Resolve a real sub-terminal session name for the cluster.
       *
       * app.js's tileSessionName(tileId) falls back to the tileId itself
       * when a tile has no `sessionName`. For a cluster that tileId looks
       * like "cluster-abc" — it is NOT a tmux session the server knows
       * about, so any downstream "switch" message or inputSender payload
       * built from that fallback gets routed to a phantom session and
       * silently dropped. Result: the cluster's sub-terminals appear
       * mounted but keystrokes do nothing and refreshing doesn't help.
       *
       * Exposing the first sub-tile's sessionName here keeps the
       * carousel's single-session "focused" model working for clusters
       * without having to teach every consumer about sub-tile focus.
       * The cluster's own focus() also points at subTiles[0], so the
       * two stay in sync.
       *
       * Returns undefined before mount (no sub-tiles exist yet); callers
       * must tolerate that, same as any other tile pre-mount.
       */
      get sessionName() {
        return subTiles[0]?.tile?.sessionName;
      },

      mount(el, ctx) {
        container = el;
        parentContext = ctx;

        gridEl = document.createElement("div");
        gridEl.className = "cluster-grid";
        gridEl.style.display = "grid";

        // Column template: use minmax if maxCellWidth is set
        const colTemplate = maxCellWidth
          ? `repeat(${cols}, minmax(0, ${maxCellWidth}))`
          : `repeat(${cols}, 1fr)`;
        gridEl.style.gridTemplateColumns = colTemplate;
        gridEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
        gridEl.style.gap = `${gap}px`;
        gridEl.style.width = "100%";
        gridEl.style.height = "100%";
        gridEl.style.padding = "4px";
        gridEl.style.boxSizing = "border-box";

        if (maxCellWidth) {
          gridEl.style.justifyContent = "center";
        }

        // Mount each slot into a grid cell (left-to-right, top-to-bottom).
        // Every slot is a terminal — no type dispatch.
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const wrapper = document.createElement("div");
          wrapper.className = "cluster-slot";
          wrapper.style.overflow = "hidden";
          wrapper.style.borderRadius = "var(--radius-md, 8px)";
          wrapper.style.position = "relative";
          wrapper.style.minWidth = "0";
          wrapper.style.minHeight = "0";

          if (slot.colSpan) wrapper.style.gridColumn = `span ${slot.colSpan}`;
          if (slot.rowSpan) wrapper.style.gridRow = `span ${slot.rowSpan}`;

          const tile = createTerminalTile(slot);
          tile.mount(wrapper, parentContext);
          subTiles.push({ tile, wrapper, index: i, slot });
          gridEl.appendChild(wrapper);
        }

        container.appendChild(gridEl);
      },

      unmount() {
        for (const { tile } of subTiles) tile.unmount();
        subTiles.length = 0;
        gridEl?.remove();
        gridEl = null;
        container = null;
        parentContext = null;
      },

      focus() {
        if (subTiles.length > 0) subTiles[0].tile.focus();
      },

      blur() {
        for (const { tile } of subTiles) tile.blur();
      },

      resize() {
        for (const { tile } of subTiles) tile.resize();
      },

      getTitle() {
        return title || "Terminal Cluster";
      },

      getIcon() {
        return "squares-four";
      },

      /**
       * Propagate a card rename into the cluster's title. The carousel
       * calls this on renameCard() via a duck-typed check; without it,
       * the cluster's display title would drift from its card id.
       */
      setSessionName(newName) {
        title = newName;
      },

      serialize() {
        // Slot schema is intentionally narrow: sessionName + optional
        // colSpan/rowSpan. The sub-tile's own serialize() is not spread
        // here because that leaks its internal type field into the slot
        // entry, which would silently break any future slot-type dispatch.
        return {
          type: "cluster",
          cols,
          rows,
          maxCellWidth: maxCellWidth || undefined,
          gap,
          title: title || undefined,
          slots: subTiles.map(({ tile, slot }) => {
            const entry = { sessionName: tile.sessionName };
            if (slot.colSpan) entry.colSpan = slot.colSpan;
            if (slot.rowSpan) entry.rowSpan = slot.rowSpan;
            return entry;
          }),
        };
      },

      getSubTiles() {
        return subTiles.map(({ tile, index }) => ({ tile, index }));
      },
    };
  };
}
