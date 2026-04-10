/**
 * Terminal renderer — wraps createTerminalTileFactory as a renderer.
 *
 * describe(props) is pure: props → { title, icon, persistable }.
 * mount(el, api) delegates to the existing tile factory and returns
 * a handle { unmount, focus, blur, resize, tile }.
 *
 * The `tile` escape hatch exposes the underlying TilePrototype for
 * carousel features that still need it (renameCard, getSubTiles on
 * clusters). Once all carousel methods go through tile-host, this
 * can be removed.
 */

import { createTerminalTileFactory } from "../tiles/terminal-tile.js";

let factory = null;

export const terminalRenderer = {
  type: "terminal",

  /** Inject deps once at startup. */
  init(deps) {
    factory = createTerminalTileFactory(deps);
  },

  describe(props) {
    return {
      title: props.sessionName || "terminal",
      icon: "terminal-window",
      persistable: true,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    if (!factory) throw new Error("terminalRenderer.init() not called");
    const tile = factory({ sessionName: props.sessionName });
    tile.mount(el, {
      ...ctx,
      // When the tile pushes title/icon changes, reflect into ui-store
      setTitle(title) {
        dispatch({ type: "ui/UPDATE_PROPS", id, patch: { title } });
      },
      setIcon(icon) {
        dispatch({ type: "ui/UPDATE_PROPS", id, patch: { icon } });
      },
    });

    return {
      unmount() { tile.unmount(); },
      focus()   { tile.focus(); },
      blur()    { tile.blur(); },
      resize()  { tile.resize(); },
      // Escape hatch for carousel rename / sub-tile queries
      tile,
    };
  },
};
