/**
 * Image renderer — wraps createImageTileFactory.
 *
 * Pure describe(props) derives title/icon from filePath.
 * Always file-backed and persistable (re-fetches on restore).
 */

import { createImageTileFactory } from "../tiles/image-tile.js";

let factory = null;

export const imageRenderer = {
  type: "image",

  init(_deps) {
    factory = createImageTileFactory(_deps);
  },

  describe(props) {
    const filePath = props.filePath || "";
    const segments = filePath.split("/").filter(Boolean);
    const filename = segments.length > 0 ? segments[segments.length - 1] : "image";

    return {
      title: filename,
      icon: "image",
      persistable: true,
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    if (!factory) throw new Error("imageRenderer.init() not called");
    const tile = factory({ filePath: props.filePath });
    tile.mount(el, {
      ...ctx,
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
      getSessions() { return []; },
      tile,
    };
  },
};
