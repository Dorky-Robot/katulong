/**
 * File-browser renderer — wraps createFileBrowserTileFactory.
 *
 * The key difference from the old tile: when cwd changes, the renderer
 * dispatches UPDATE_PROPS into ui-store instead of calling ctx.setTitle.
 * The tab bar re-derives the title from describe(newProps) on the next
 * state change — no push-based notification chain.
 */

import { createFileBrowserTileFactory } from "../tiles/file-browser-tile.js";

let factory = null;

export const fileBrowserRenderer = {
  type: "file-browser",

  init(_deps) {
    factory = createFileBrowserTileFactory(_deps);
  },

  describe(props) {
    const cwd = typeof props.cwd === "string" ? props.cwd : "";
    if (!cwd || cwd === "/") return { title: "Files", icon: "folder", persistable: true };
    const segments = cwd.split("/").filter(Boolean);
    return {
      title: segments.length > 0 ? segments[segments.length - 1] : "Files",
      icon: "folder",
      persistable: true,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    if (!factory) throw new Error("fileBrowserRenderer.init() not called");
    const tile = factory({ cwd: props.cwd || "", sessionName: props.sessionName });
    tile.mount(el, {
      ...ctx,
      // Intercept setTitle — translate into ui-store dispatch so the
      // tab bar picks it up reactively instead of imperatively.
      setTitle(_title) {
        // The fb tile calls setTitle with the folder name, but we want
        // the full cwd in props so describe() can derive the title.
        dispatch({ type: "ui/UPDATE_PROPS", id, patch: { cwd: tile.cwd } });
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
      tile,
    };
  },
};
