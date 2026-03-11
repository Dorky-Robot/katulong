/**
 * File Browser Component — Miller Columns
 *
 * Finder column-view: each directory drills into the next column to the right.
 * Single tap/click on a folder opens it. Single tap/click on a file selects it.
 * Double-click on a file downloads it.
 */

import { selectItem, goBack, refreshAll, getDeepestPath, loadRoot, filterHidden } from "/lib/file-browser/file-browser-store.js";
import { getFileIcon } from "/lib/file-browser/file-browser-types.js";
import { createContextMenu } from "/lib/file-browser/file-browser-context-menu.js";
import { createFileBrowserActions } from "/lib/file-browser/file-browser-actions.js";
import { initColumnDnD } from "/lib/file-browser/file-browser-dnd.js";

export function createFileBrowserComponent(store, options = {}) {
  const { onClose } = options;
  let container = null;
  let unsubscribe = null;
  let columnsEl = null;

  const actions = createFileBrowserActions(store);
  const contextMenu = createContextMenu({
    onAction: (action, entryName, selection) => {
      if (!container) return;
      const state = store.getState();
      const names = entryName ? [entryName] : [];
      const activeCol = state.columns.length > 0 ? state.columns[state.columns.length - 1] : null;
      const currentPath = activeCol ? activeCol.path : "/";

      switch (action) {
        case "open":
          if (entryName) {
            // Find which column has this entry
            for (let i = state.columns.length - 1; i >= 0; i--) {
              if (state.columns[i].entries.some(e => e.name === entryName)) {
                selectItem(store, i, entryName);
                break;
              }
            }
          }
          break;
        case "download":
          if (entryName) actions.downloadFile(entryName);
          break;
        case "rename":
          if (entryName) actions.startRename(container, entryName);
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
          actions.newFolder(container);
          break;
        case "upload":
          actions.uploadFiles(container);
          break;
      }
    },
  });

  function mount(el) {
    container = el;
    container.innerHTML = "";
    container.className = "file-browser";

    container.innerHTML = `
      <div class="fb-toolbar">
        <div class="fb-toolbar-nav">
          <button class="fb-btn fb-back-btn" aria-label="Go back">
            <i class="ph ph-caret-left"></i>
          </button>
          <button class="fb-btn fb-forward-btn" aria-label="Go forward">
            <i class="ph ph-caret-right"></i>
          </button>
        </div>
        <div class="fb-breadcrumb" aria-label="Path breadcrumb"></div>
        <div class="fb-toolbar-actions">
          <button class="fb-btn fb-hidden-btn${store.getState().showHidden ? " fb-active" : ""}" aria-label="Toggle hidden files">
            <i class="ph ph-eye${store.getState().showHidden ? "" : "-slash"}"></i>
          </button>
          <button class="fb-btn fb-refresh-btn" aria-label="Refresh">
            <i class="ph ph-arrow-clockwise"></i>
          </button>
          <button class="fb-btn fb-close-btn" aria-label="Close file browser">
            <i class="ph ph-x"></i>
          </button>
        </div>
      </div>
      <div class="fb-columns" tabindex="0"></div>
      <div class="fb-status"></div>
    `;

    const backBtn = container.querySelector(".fb-back-btn");
    const fwdBtn = container.querySelector(".fb-forward-btn");
    const closeBtn = container.querySelector(".fb-close-btn");
    const refreshBtn = container.querySelector(".fb-refresh-btn");
    columnsEl = container.querySelector(".fb-columns");

    const hiddenBtn = container.querySelector(".fb-hidden-btn");
    hiddenBtn.addEventListener("click", () => store.dispatch({ type: "TOGGLE_HIDDEN" }));

    backBtn.addEventListener("click", () => goBack(store));
    fwdBtn.addEventListener("click", () => {
      // Navigate into selected folder
      const state = store.getState();
      const lastCol = state.columns[state.columns.length - 1];
      if (lastCol?.selected) {
        selectItem(store, state.columns.length - 1, lastCol.selected);
      }
    });
    if (closeBtn && onClose) closeBtn.addEventListener("click", onClose);
    refreshBtn.addEventListener("click", () => refreshAll(store));

    // Event delegation for all column interactions (click, dblclick, contextmenu)
    columnsEl.addEventListener("click", (e) => {
      const row = e.target.closest(".fb-miller-row");
      if (!row) return;
      const colIndex = parseInt(row.dataset.col, 10);
      selectItem(store, colIndex, row.dataset.name);
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
      const menuState = {
        selection: entryName ? [entryName] : [],
        clipboard: store.getState().clipboard,
      };
      contextMenu.show(e, menuState);
    });

    // Keyboard navigation on the columns container
    columnsEl.addEventListener("keydown", (e) => handleKeyDown(e));

    // All drag-and-drop (external upload + internal move/copy)
    initColumnDnD(columnsEl, store);

    unsubscribe = store.subscribe(() => render());
    render();
  }

  function handleKeyDown(e) {
    const state = store.getState();
    if (state.columns.length === 0) return;

    // Find the "active" column (last column with a selection, or the last column)
    let activeColIdx = state.columns.length - 1;
    for (let i = state.columns.length - 1; i >= 0; i--) {
      if (state.columns[i].selected !== null) {
        activeColIdx = i;
        break;
      }
    }
    const col = state.columns[activeColIdx];
    if (!col) return;

    const entries = filterHidden(col.entries, state.showHidden);
    const selectedName = col.selected;
    const names = entries.map(en => en.name);
    const currentIdx = selectedName ? names.indexOf(selectedName) : -1;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(currentIdx + 1, names.length - 1);
      if (next >= 0) selectItem(store, activeColIdx, names[next]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = currentIdx <= 0 ? 0 : currentIdx - 1;
      if (names.length > 0) selectItem(store, activeColIdx, names[prev]);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      // Drill into selected folder
      if (selectedName) {
        const entry = entries.find(en => en.name === selectedName);
        if (entry?.type === "directory" && state.columns[activeColIdx + 1]) {
          // Focus the next column — select its first item
          const nextCol = state.columns[activeColIdx + 1];
          if (nextCol.entries.length > 0) {
            selectItem(store, activeColIdx + 1, nextCol.entries[0].name);
          }
        }
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      // Go up to parent column
      if (activeColIdx > 0) {
        // The parent column already has a selection; just focus it by
        // re-selecting to trim children
        const parentCol = state.columns[activeColIdx - 1];
        if (parentCol.selected) {
          store.dispatch({ type: "CLEAR_SELECTION", columnIndex: activeColIdx - 1 });
          store.dispatch({ type: "SELECT_ITEM", columnIndex: activeColIdx - 1, name: parentCol.selected });
        }
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedName) {
        const entry = entries.find(en => en.name === selectedName);
        if (entry?.type === "file") {
          const filePath = col.path + "/" + selectedName;
          window.open(`/api/files/download?path=${encodeURIComponent(filePath)}`, "_blank");
        }
      }
    } else if (e.key === "Backspace") {
      e.preventDefault();
      goBack(store);
    }
  }

  function render() {
    if (!container || !columnsEl) return;
    const state = store.getState();

    // Update hidden toggle button
    const hiddenBtn = container.querySelector(".fb-hidden-btn");
    if (hiddenBtn) {
      hiddenBtn.classList.toggle("fb-active", state.showHidden);
      const icon = hiddenBtn.querySelector("i");
      icon.className = state.showHidden ? "ph ph-eye" : "ph ph-eye-slash";
    }

    // Back/forward button states
    const backBtn = container.querySelector(".fb-back-btn");
    const fwdBtn = container.querySelector(".fb-forward-btn");
    backBtn.disabled = state.columns.length <= 1;
    // Forward enabled if last column has a selected directory
    const lastCol = state.columns[state.columns.length - 1];
    const lastSelected = lastCol?.selected;
    const lastEntry = lastSelected && lastCol?.entries.find(e => e.name === lastSelected);
    fwdBtn.disabled = !lastEntry || lastEntry.type !== "directory";

    // Breadcrumb
    renderBreadcrumb(state);

    // Render columns
    renderColumns(state);

    // Status bar
    const status = container.querySelector(".fb-status");
    const deepest = getDeepestPath(state);
    const lastColData = state.columns[state.columns.length - 1];
    const visibleCount = lastColData ? filterHidden(lastColData.entries, state.showHidden).length : 0;
    status.textContent = `${deepest}  —  ${visibleCount} item${visibleCount !== 1 ? "s" : ""}`;
  }

  let prevColumnCount = 0;

  function renderColumns(state) {
    const { columns } = state;

    // Ensure correct number of column elements
    while (columnsEl.children.length > columns.length) {
      columnsEl.removeChild(columnsEl.lastElementChild);
    }
    while (columnsEl.children.length < columns.length) {
      const colEl = document.createElement("div");
      colEl.className = "fb-miller-col";
      columnsEl.appendChild(colEl);
    }

    // Update each column
    for (let i = 0; i < columns.length; i++) {
      const colEl = columnsEl.children[i];
      colEl.dataset.path = columns[i].path;
      colEl.dataset.index = i;
      renderSingleColumn(colEl, columns[i], i);
    }

    // Auto-scroll to the rightmost column when a new column was added
    if (columns.length > prevColumnCount && columns.length > 0) {
      const lastColEl = columnsEl.lastElementChild;
      if (lastColEl) {
        lastColEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "end" });
      }
    }
    prevColumnCount = columns.length;
  }

  function renderSingleColumn(colEl, col, colIndex) {
    if (col.loading) {
      colEl.innerHTML = '<div class="fb-miller-loading"><span class="fb-loading-spinner"></span></div>';
      return;
    }
    if (col.error) {
      colEl.innerHTML = `<div class="fb-miller-empty fb-error">${escapeHtml(col.error)}</div>`;
      return;
    }

    const { showHidden } = store.getState();
    const visibleEntries = filterHidden(col.entries, showHidden);

    if (visibleEntries.length === 0) {
      colEl.innerHTML = '<div class="fb-miller-empty">Empty</div>';
      return;
    }

    const html = visibleEntries.map(entry => {
      const selected = col.selected === entry.name;
      const isDir = entry.type === "directory";
      return `<div class="fb-miller-row${selected ? " fb-miller-selected" : ""}" data-name="${escapeAttr(entry.name)}" data-type="${entry.type}" data-col="${colIndex}" draggable="true">
        <span class="fb-miller-icon">${getFileIcon(entry)}</span>
        <span class="fb-miller-name">${escapeHtml(entry.name)}</span>
        ${isDir ? '<span class="fb-miller-chevron"><i class="ph ph-caret-right"></i></span>' : ''}
      </div>`;
    }).join("");

    colEl.innerHTML = html;

    // Scroll selected row into view
    if (col.selected) {
      const selectedRow = colEl.querySelector(`.fb-miller-row[data-name="${CSS.escape(col.selected)}"]`);
      if (selectedRow) selectedRow.scrollIntoView({ block: "nearest" });
    }
  }

  function renderBreadcrumb(state) {
    const breadcrumb = container.querySelector(".fb-breadcrumb");
    const deepest = getDeepestPath(state);
    if (!deepest) {
      breadcrumb.innerHTML = "";
      return;
    }

    const parts = deepest.split("/").filter(Boolean);
    let html = `<span class="fb-crumb" data-path="/" data-depth="0">/</span>`;
    let accumulated = "";
    for (let i = 0; i < parts.length; i++) {
      accumulated += "/" + parts[i];
      html += `<span class="fb-crumb-sep">/</span><span class="fb-crumb" data-path="${escapeAttr(accumulated)}" data-depth="${i + 1}">${escapeHtml(parts[i])}</span>`;
    }
    breadcrumb.innerHTML = html;

    breadcrumb.querySelectorAll(".fb-crumb").forEach(crumb => {
      crumb.addEventListener("click", () => {
        // Navigate to this depth by loading it as root
        loadRoot(store, crumb.dataset.path);
      });
    });
  }

  function unmount() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    contextMenu.close();
    container = null;
    columnsEl = null;
  }

  function getContainer() { return container; }

  function focus() {
    if (columnsEl) columnsEl.focus();
  }

  return { mount, unmount, getContainer, focus, render };
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
