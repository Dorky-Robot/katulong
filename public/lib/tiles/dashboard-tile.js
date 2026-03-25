/**
 * Dashboard Tile
 *
 * A tile that contains sub-tiles in a CSS Grid layout. Any TilePrototype
 * can be nested as a sub-tile, enabling composition (e.g. two terminals
 * side-by-side, a terminal + web preview, etc.).
 */

const LAYOUTS = {
  "2x1": { cols: "1fr 1fr", rows: "1fr",    areas: [["a", "b"]] },
  "1x2": { cols: "1fr",     rows: "1fr 1fr", areas: [["a"], ["b"]] },
  "2x2": { cols: "1fr 1fr", rows: "1fr 1fr", areas: [["a", "b"], ["c", "d"]] },
  "1+2": { cols: "1fr 1fr", rows: "1fr 1fr", areas: [["a", "b"], ["a", "c"]] },
};

/**
 * Create the dashboard tile factory.
 *
 * @param {object} deps
 * @param {(type: string, options: object) => TilePrototype} deps.createTileFn
 *   Function to create sub-tiles (usually the registry's createTile).
 * @returns {(options: object) => TilePrototype}
 */
export function createDashboardTileFactory({ createTileFn }) {
  /**
   * @param {object} options
   * @param {string} options.layout — layout key ("2x1", "1x2", "2x2", "1+2")
   * @param {Array<{area: string, type: string, [key: string]: any}>} options.slots
   */
  return function createDashboardTile({ layout = "2x1", slots = [] } = {}) {
    let container = null;
    let gridEl = null;
    let parentContext = null;
    const subTiles = []; // Array<{ tile, wrapper, area }>

    return {
      type: "dashboard",

      mount(el, ctx) {
        container = el;
        parentContext = ctx;

        gridEl = document.createElement("div");
        gridEl.className = "dashboard-grid";

        const layoutDef = LAYOUTS[layout] || LAYOUTS["2x1"];
        gridEl.style.display = "grid";
        gridEl.style.gridTemplateColumns = layoutDef.cols;
        gridEl.style.gridTemplateRows = layoutDef.rows;
        gridEl.style.gridTemplateAreas = layoutDef.areas
          .map(row => `"${row.join(" ")}"`)
          .join(" ");
        gridEl.style.gap = "8px";
        gridEl.style.width = "100%";
        gridEl.style.height = "100%";
        gridEl.style.padding = "4px";
        gridEl.style.boxSizing = "border-box";

        for (const slot of slots) {
          const wrapper = document.createElement("div");
          wrapper.className = "dashboard-slot";
          wrapper.style.gridArea = slot.area;
          wrapper.style.overflow = "hidden";
          wrapper.style.borderRadius = "var(--radius-md, 8px)";
          wrapper.style.position = "relative";

          const tile = createTileFn(slot.type, slot);
          tile.mount(wrapper, parentContext);
          subTiles.push({ tile, wrapper, area: slot.area });
          gridEl.appendChild(wrapper);
        }

        container.appendChild(gridEl);
      },

      unmount() {
        for (const { tile } of subTiles) {
          tile.unmount();
        }
        subTiles.length = 0;
        gridEl?.remove();
        gridEl = null;
        container = null;
        parentContext = null;
      },

      focus() {
        // Focus the first sub-tile
        if (subTiles.length > 0) subTiles[0].tile.focus();
      },

      blur() {
        for (const { tile } of subTiles) tile.blur();
      },

      resize() {
        for (const { tile } of subTiles) tile.resize();
      },

      getTitle() {
        return "Dashboard";
      },

      getIcon() {
        return "squares-four";
      },

      serialize() {
        return {
          type: "dashboard",
          layout,
          slots: subTiles.map(({ tile, area }) => ({
            area,
            type: tile.type,
            ...(typeof tile.serialize === "function" ? tile.serialize() : {}),
          })),
        };
      },

      /** Access sub-tiles for inspection / testing. */
      getSubTiles() {
        return subTiles.map(({ tile, area }) => ({ tile, area }));
      },
    };
  };
}
