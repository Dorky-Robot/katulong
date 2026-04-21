/**
 * Document renderer — wraps createDocumentTileFactory.
 *
 * Pure describe(props) derives title/icon/persistable from props.
 * Persistable is instance-level: file-backed documents persist
 * (re-fetch on restore), content-backed ones don't.
 */

import { createDocumentTileFactory } from "../tiles/document-tile.js";

let factory = null;

export const documentRenderer = {
  type: "document",

  init(_deps) {
    factory = createDocumentTileFactory(_deps);
  },

  describe(props) {
    const filePath = props.filePath || "";
    const isFileBacked = !!filePath;

    let filename = props.title || "document";
    let ext = "";
    if (filePath) {
      const segments = filePath.split("/").filter(Boolean);
      filename = segments.length > 0 ? segments[segments.length - 1] : "file";
      ext = filename.includes(".")
        ? "." + filename.split(".").pop().toLowerCase()
        : "";
    }

    let icon = "document";
    if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs",
         ".sh", ".bash", ".zsh", ".sql", ".html", ".css"].includes(ext)) icon = "code";
    if ([".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg"].includes(ext)) icon = "settings";
    if (ext === ".md") icon = "article";

    return {
      title: filename,
      icon,
      persistable: isFileBacked,
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    if (!factory) throw new Error("documentRenderer.init() not called");
    const tile = factory({
      filePath: props.filePath,
      title: props.title,
      content: props.content,
      format: props.format,
      worktreeLabel: props.worktreeLabel,
    });
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
