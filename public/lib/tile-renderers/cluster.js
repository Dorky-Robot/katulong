/**
 * Cluster renderer — wraps createClusterTileFactory.
 *
 * Clusters are compound tiles: a grid of sub-terminal-tiles. The
 * renderer delegates entirely to the existing factory. describe() is
 * pure; mount() returns the standard handle plus the tile escape hatch
 * for getSubTiles() access.
 */

import { createClusterTileFactory } from "../tiles/cluster-tile.js";

let factory = null;

export const clusterRenderer = {
  type: "cluster",

  /** Inject deps — needs createTerminalTile (the raw factory, not renderer). */
  init(deps) {
    factory = createClusterTileFactory(deps);
  },

  describe(props) {
    return {
      title: props.title || "Terminal Cluster",
      icon: "squares-four",
      persistable: true,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    if (!factory) throw new Error("clusterRenderer.init() not called");
    const tile = factory({
      cols: props.cols,
      rows: props.rows,
      cells: props.cells,
      maxCellWidth: props.maxCellWidth,
      gap: props.gap,
      title: props.title,
      slots: props.slots || [],
    });
    tile.mount(el, ctx);

    return {
      unmount() { tile.unmount(); },
      focus()   { tile.focus(); },
      blur()    { tile.blur(); },
      resize()  { tile.resize(); },
      tile,
    };
  },
};
