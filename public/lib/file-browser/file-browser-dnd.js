/**
 * File Browser Drag and Drop — Finder-style
 *
 * Drop target logic (same for external uploads and internal moves):
 * - Drop on blank space in a column → target is that column's directory
 * - Drop on a folder row → target is that folder
 * - Drop on a file row → target is that file's parent directory (sibling)
 */

import { api } from "/lib/api-client.js";
import { uploadFile } from "/lib/file-browser/file-browser-actions.js";

/**
 * @param {HTMLElement} columnsEl
 * @param {object} store — file-browser store
 * @param {object} nav — navigation controller (for refreshAll)
 */
export function initColumnDnD(columnsEl, store, nav) {
  let internalDrag = null; // { items: [path, ...] }

  // --- Resolve drop target path from the event ---
  function resolveDropTarget(e) {
    const row = e.target.closest(".fb-miller-row");
    const colEl = e.target.closest(".fb-miller-col");

    if (row) {
      const ci = parseInt(row.dataset.col, 10);
      const col = store.getState().columns[ci];
      if (!col) return null;

      if (row.dataset.type === "directory") {
        // Dropped on a folder → upload into it
        return col.path + "/" + row.dataset.name;
      }
      // Dropped on a file → sibling (the column's directory)
      return col.path;
    }

    if (colEl) {
      // Dropped on blank space in a column
      const ci = parseInt(colEl.dataset.index, 10);
      const col = store.getState().columns[ci];
      return col ? col.path : null;
    }

    return null;
  }

  // --- Visual: highlight drop target ---
  function updateHighlight(e) {
    clearHighlights();
    const row = e.target.closest(".fb-miller-row");
    const colEl = e.target.closest(".fb-miller-col");

    if (row && row.dataset.type === "directory") {
      row.classList.add("fb-drop-target");
    } else if (colEl) {
      colEl.classList.add("fb-drop-target-col");
    }
  }

  function clearHighlights() {
    columnsEl.querySelectorAll(".fb-drop-target").forEach(el => el.classList.remove("fb-drop-target"));
    columnsEl.querySelectorAll(".fb-drop-target-col").forEach(el => el.classList.remove("fb-drop-target-col"));
  }

  // --- Internal dragstart ---
  columnsEl.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".fb-miller-row");
    if (!row) return;

    const colEl = row.closest(".fb-miller-col");
    const ci = colEl ? parseInt(colEl.dataset.index, 10) : -1;
    const col = store.getState().columns[ci];
    if (!col) return;

    internalDrag = { items: [col.path + "/" + row.dataset.name] };
    e.dataTransfer.setData("application/x-katulong-files", JSON.stringify(internalDrag.items));
    e.dataTransfer.effectAllowed = "copyMove";
  });

  // --- dragover: always allow drop, show highlight ---
  columnsEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = internalDrag ? (e.altKey ? "copy" : "move") : "copy";
    updateHighlight(e);
  });

  columnsEl.addEventListener("dragleave", (e) => {
    // Only clear if leaving the columns area entirely
    if (!columnsEl.contains(e.relatedTarget)) {
      clearHighlights();
    }
  });

  // --- drop: unified handler ---
  columnsEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearHighlights();

    const targetPath = resolveDropTarget(e);
    if (!targetPath) {
      internalDrag = null;
      return;
    }

    if (internalDrag) {
      // Internal: move or copy
      const endpoint = e.altKey ? "/api/files/copy" : "/api/files/move";
      try {
        await api.post(endpoint, { items: internalDrag.items, destination: targetPath });
        await nav.refreshAll();
      } catch (err) {
        alert(`${e.altKey ? "Copy" : "Move"} failed: ${err.message}`);
      }
      internalDrag = null;
      return;
    }

    // External: upload files from OS
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    for (const file of files) {
      try {
        await uploadFile(targetPath, file);
      } catch (err) {
        alert(`Upload failed for ${file.name}: ${err.message}`);
      }
    }
    await nav.refreshAll();
  });

  columnsEl.addEventListener("dragend", () => {
    internalDrag = null;
    clearHighlights();
  });
}
