/**
 * File-browser renderer — wraps createFileBrowserTileFactory.
 *
 * The key difference from the old tile: when cwd changes, the renderer
 * dispatches UPDATE_PROPS into ui-store instead of calling ctx.setTitle.
 * The tab bar re-derives the title from describe(newProps) on the next
 * state change — no push-based notification chain.
 */

import { createFileBrowserTileFactory } from "../tiles/file-browser-tile.js";
import { isImagePath } from "../tiles/image-tile.js";

let factory = null;
let _uiStore = null;

export const fileBrowserRenderer = {
  type: "file-browser",

  init(deps) {
    factory = createFileBrowserTileFactory(deps);
    _uiStore = deps.uiStore || null;
  },

  describe(props) {
    const cwd = typeof props.cwd === "string" ? props.cwd : "";
    if (!cwd || cwd === "/") return {
      title: "Files", icon: "folder", persistable: true,
      session: null, updatesUrl: false, renameable: false, handlesDnd: true,
    };
    const segments = cwd.split("/").filter(Boolean);
    return {
      title: segments.length > 0 ? segments[segments.length - 1] : "Files",
      icon: "folder",
      persistable: true,
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: true,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    if (!factory) throw new Error("fileBrowserRenderer.init() not called");

    // --- File open: open a document or image tile adjacent to this browser ---
    function onFileOpen(filePath) {
      if (!_uiStore) return;
      const state = _uiStore.getState();

      const isImage = isImagePath(filePath);
      const previewType = isImage ? "image" : "document";

      // Swap semantics: if the tile immediately to the right is already
      // a preview tile (document or image), remove it first so we get
      // one preview pane, not an accumulating stack.
      const thisTile = state.tiles[id];
      if (thisTile) {
        const rightX = thisTile.x + 1;
        for (const [tid, t] of Object.entries(state.tiles)) {
          if (t.x === rightX && (t.type === "document" || t.type === "image")) {
            _uiStore.removeTile(tid);
            break;
          }
        }
      }

      // Single dispatch — insertAfter places the tile right of
      // this browser tile. focus:true sets focusedId in the store;
      // tile-host reacts and tells the carousel to scroll to it.
      const tileId = `${isImage ? "img" : "doc"}-${Date.now().toString(36)}`;
      _uiStore.addTile(
        { id: tileId, type: previewType, props: { filePath } },
        { focus: true, insertAfter: id },
      );
    }

    // --- File download: open download URL in new tab ---
    function onFileDownload(filePath) {
      window.open(`/api/files/download?path=${encodeURIComponent(filePath)}`, "_blank");
    }

    const tile = factory({
      cwd: props.cwd || "",
      sessionName: props.sessionName,
      onFileOpen,
      onFileDownload,
    });

    tile.mount(el, {
      ...ctx,
      // Intercept setTitle — translate into ui-store dispatch so the
      // tab bar picks it up reactively instead of imperatively.
      setTitle(_title) {
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
      getSessions() { return []; },
      tile,
    };
  },
};
