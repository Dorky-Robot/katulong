/**
 * File Browser Component — Miller Columns
 *
 * Thin orchestrator that composes extracted modules:
 *   - file-browser-toolbar.js  — toolbar factory (nav, breadcrumb, actions)
 *   - file-browser-columns.js  — pure column rendering
 *   - file-browser-keyboard.js — keyboard handler factory
 *   - file-browser-actions.js  — file operations (rename, delete, etc.)
 *   - file-browser-dnd.js      — drag-and-drop
 *   - file-browser-context-menu.js — right-click menu
 *
 * The component subscribes to the store and delegates rendering to
 * pure functions. It owns the DOM structure (.fb-root) but not the
 * rendering logic for any individual piece.
 *
 * See docs/file-browser-refactor.md for the design rationale.
 */

import { api } from "/lib/api-client.js";
import { getDeepestPath, filterHidden } from "/lib/file-browser/file-browser-store.js";
import { renderColumns } from "/lib/file-browser/file-browser-columns.js";
import { createToolbar } from "/lib/file-browser/file-browser-toolbar.js";
import { createKeyboardHandler } from "/lib/file-browser/file-browser-keyboard.js";
import { createContextMenu } from "/lib/file-browser/file-browser-context-menu.js";
import { createFileBrowserActions } from "/lib/file-browser/file-browser-actions.js";
import { initColumnDnD } from "/lib/file-browser/file-browser-dnd.js";
import { createFileWatcher } from "/lib/file-browser/file-browser-watcher.js";

/**
 * @param {object} store — file-browser store instance
 * @param {object} nav — navigation controller (from createNavController)
 * @param {object} [options]
 * @param {function} [options.onClose] — called when user clicks the X button
 */
export function createFileBrowserComponent(store, nav, options = {}) {
  const { onClose } = options;
  let root = null;
  let columnsEl = null;
  let statusEl = null;
  let toolbar = null;
  let unsubscribe = null;
  let watcher = null;

  const actions = createFileBrowserActions(store, nav);
  const keyboardHandler = createKeyboardHandler(nav, store);
  const contextMenu = createContextMenu({
    onAction: (action, entryName) => {
      if (!root) return;
      const state = store.getState();
      const names = entryName ? [entryName] : [];

      switch (action) {
        case "open":
          if (entryName) {
            for (let i = state.columns.length - 1; i >= 0; i--) {
              if (state.columns[i].entries.some(e => e.name === entryName)) {
                nav.selectItem(i, entryName);
                break;
              }
            }
          }
          break;
        case "download":
          if (entryName) actions.downloadFile(entryName);
          break;
        case "rename":
          if (entryName) actions.startRename(root, entryName);
          break;
        case "copy":
          actions.copyItems(names);
          break;
        case "cut":
          actions.cutItems(names);
          break;
        case "paste":
          actions.pasteItems();
          break;
        case "delete":
          actions.deleteItems(names);
          break;
        case "new-folder":
          actions.newFolder(root);
          break;
        case "upload":
          actions.uploadFiles(root);
          break;
      }
    },
  });

  function mount(el) {
    root = document.createElement("div");
    root.className = "fb-root";
    el.appendChild(root);

    // Toolbar
    toolbar = createToolbar({
      onBack: () => nav.goBack(),
      onForward: () => {
        const state = store.getState();
        const lastCol = state.columns[state.columns.length - 1];
        if (lastCol?.selected) {
          nav.selectItem(state.columns.length - 1, lastCol.selected);
        }
      },
      onToggleHidden: () => store.dispatch({ type: "TOGGLE_HIDDEN" }),
      onClose,
      onBreadcrumbNav: (path) => nav.loadRoot(path),
    });
    root.appendChild(toolbar.el);

    // Live filesystem watcher — replaces manual refresh button
    watcher = createFileWatcher(nav, store);

    // Columns container
    columnsEl = document.createElement("div");
    columnsEl.className = "fb-columns";
    columnsEl.tabIndex = 0;
    root.appendChild(columnsEl);

    // Status bar
    statusEl = document.createElement("div");
    statusEl.className = "fb-status";
    root.appendChild(statusEl);

    // Event delegation on columns
    columnsEl.addEventListener("click", (e) => {
      // "Grant Access" button in permission error columns
      const grantBtn = e.target.closest(".fb-grant-access-btn");
      if (grantBtn) {
        api.post("/api/files/open-privacy-settings", {});
        return;
      }

      const row = e.target.closest(".fb-miller-row");
      if (!row) return;
      const colIndex = parseInt(row.dataset.col, 10);
      nav.selectItem(colIndex, row.dataset.name);
    });

    columnsEl.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".fb-miller-row");
      if (!row || row.dataset.type !== "file") return;
      const colIndex = parseInt(row.dataset.col, 10);
      const state = store.getState();
      const col = state.columns[colIndex];
      if (!col) return;
      const filePath = col.path + "/" + row.dataset.name;
      window.open(`/api/files/download?path=${encodeURIComponent(filePath)}`, "_blank");
    });

    columnsEl.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".fb-miller-row");
      const entryName = row?.dataset.name || null;
      contextMenu.show(e, {
        selection: entryName ? [entryName] : [],
        clipboard: store.getState().clipboard,
      });
    });

    columnsEl.addEventListener("keydown", keyboardHandler);

    initColumnDnD(columnsEl, store, nav);

    unsubscribe = store.subscribe(() => {
      render();
      watcher.sync();
    });
    render();
  }

  function render() {
    if (!root || !columnsEl) return;
    const state = store.getState();

    toolbar.update(state);
    renderColumns(columnsEl, state.columns, state.showHidden);

    // Status bar
    const deepest = getDeepestPath(state);
    const lastCol = state.columns[state.columns.length - 1];
    const visibleCount = lastCol ? filterHidden(lastCol.entries, state.showHidden).length : 0;
    statusEl.textContent = `${deepest}  —  ${visibleCount} item${visibleCount !== 1 ? "s" : ""}`;
  }

  function unmount() {
    if (watcher) watcher.stop();
    watcher = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    contextMenu.close();
    if (root && root.parentElement) {
      root.parentElement.removeChild(root);
    }
    root = null;
    columnsEl = null;
    statusEl = null;
    toolbar = null;
  }

  function focus() {
    if (columnsEl) columnsEl.focus();
  }

  return { mount, unmount, focus, render };
}
