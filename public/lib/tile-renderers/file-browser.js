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
import { tileLocator } from "../selectors.js";

let factory = null;
let _uiStore = null;

/**
 * Find the preview tile (if any) immediately right of a file-browser that
 * should be swapped out before inserting a new preview. Pure — takes state,
 * returns id or null. Exported for tests.
 *
 * Under v3 the neighbor is `clusters[c][col + 1][0]`. MC1 is single-slot so
 * `[0]` is the only row; when columns grow this fn needs to reconsider what
 * "the preview pane" means structurally.
 */
export function findAdjacentPreviewToSwap(state, browserId) {
  const path = tileLocator(state).get(browserId);
  if (!path) return null;
  const neighborHead = state.clusters[path.c]?.[path.col + 1]?.[0];
  if (!neighborHead) return null;
  if (neighborHead.type !== "document" && neighborHead.type !== "image") return null;
  return neighborHead.id;
}

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

      // Swap semantics: if the column immediately to the right is a
      // preview tile (document or image), remove it first so we get
      // one preview pane, not an accumulating stack.
      const previewToSwap = findAdjacentPreviewToSwap(state, id);
      if (previewToSwap) _uiStore.removeTile(previewToSwap);

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
