/**
 * Dashboard Tile
 *
 * A configurable grid tile that contains sub-tiles (cells). Specify the
 * number of columns and rows, and optionally a max cell width. Cells are
 * filled in order — each slot maps to a grid cell left-to-right,
 * top-to-bottom.
 *
 * Usage:
 *   createTile("dashboard", {
 *     cols: 3,                        // 3 columns
 *     rows: 2,                        // 2 rows (6 cells total)
 *     maxCellWidth: "400px",          // optional max width per column
 *     gap: 8,                         // gap in px (default 8)
 *     title: "My Dashboard",          // optional custom title
 *     slots: [
 *       { type: "terminal", sessionName: "dev" },
 *       { type: "terminal", sessionName: "logs" },
 *       { type: "html", content: "<h1>Status</h1>" },
 *     ]
 *   })
 *
 * Shorthand: pass just `cells` to auto-compute a grid:
 *   createTile("dashboard", { cells: 4, slots: [...] })
 *   // → 2x2 grid (auto-layout picks the squarest arrangement)
 */

/**
 * Auto-compute cols × rows for a given cell count.
 * Picks the squarest arrangement, favoring wider over taller.
 */
function autoGrid(cells) {
  const cols = Math.ceil(Math.sqrt(cells));
  const rows = Math.ceil(cells / cols);
  return { cols, rows };
}

/**
 * Create the dashboard tile factory.
 *
 * @param {object} deps
 * @param {(type: string, options: object) => TilePrototype} deps.createTileFn
 * @returns {(options: object) => TilePrototype}
 */
export function createDashboardTileFactory({ createTileFn }) {
  /**
   * @param {object} options
   * @param {number} [options.cols] — number of columns
   * @param {number} [options.rows] — number of rows
   * @param {number} [options.cells] — total cells (auto-computes cols/rows)
   * @param {string} [options.maxCellWidth] — CSS max-width per column (e.g. "400px")
   * @param {number} [options.gap=8] — gap between cells in px
   * @param {string} [options.title] — custom dashboard title
   * @param {Array<{type: string, [key: string]: any}>} options.slots
   */
  return function createDashboardTile(options = {}) {
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
    const subTiles = []; // Array<{ tile, wrapper, index }>

    return {
      type: "dashboard",

      mount(el, ctx) {
        container = el;
        parentContext = ctx;

        gridEl = document.createElement("div");
        gridEl.className = "dashboard-grid";
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

        // If using maxCellWidth, center the grid
        if (maxCellWidth) {
          gridEl.style.justifyContent = "center";
        }

        // Mount each slot into a grid cell (left-to-right, top-to-bottom)
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const wrapper = document.createElement("div");
          wrapper.className = "dashboard-slot";
          wrapper.style.overflow = "hidden";
          wrapper.style.borderRadius = "var(--radius-md, 8px)";
          wrapper.style.position = "relative";
          wrapper.style.minWidth = "0";
          wrapper.style.minHeight = "0";

          // Allow slots to span multiple cells
          if (slot.colSpan) wrapper.style.gridColumn = `span ${slot.colSpan}`;
          if (slot.rowSpan) wrapper.style.gridRow = `span ${slot.rowSpan}`;

          const tile = createTileFn(slot.type, slot);
          tile.mount(wrapper, parentContext);
          subTiles.push({ tile, wrapper, index: i });
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
        return title || "Dashboard";
      },

      getIcon() {
        return "squares-four";
      },

      serialize() {
        return {
          type: "dashboard",
          cols,
          rows,
          maxCellWidth: maxCellWidth || undefined,
          gap,
          title: title || undefined,
          slots: subTiles.map(({ tile }) => ({
            type: tile.type,
            ...(typeof tile.serialize === "function" ? tile.serialize() : {}),
          })),
        };
      },

      getSubTiles() {
        return subTiles.map(({ tile, index }) => ({ tile, index }));
      },
    };
  };
}
