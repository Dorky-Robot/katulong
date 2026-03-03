/**
 * File Browser Drag and Drop
 *
 * Handles:
 * - External drag (OS → browser): upload files
 * - Internal drag (within browser): move/copy files between folders
 */

import { api } from "/lib/api-client.js";
import { refreshDirectory, navigateTo } from "/lib/file-browser/file-browser-store.js";

/**
 * Initialize drag-and-drop on the file browser container.
 * @param {HTMLElement} container - The file browser container
 * @param {object} store - File browser store
 */
export function initFileBrowserDnD(container, store) {
  let dragCounter = 0;
  let dropOverlay = null;
  let internalDragData = null; // { items: [...paths] }

  const list = container.querySelector(".fb-list");
  if (!list) return;

  // --- External drop (upload from OS) ---

  list.addEventListener("dragenter", (e) => {
    // Only show overlay for external files
    if (internalDragData) return;
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) showDropOverlay();
  });

  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Show drop target highlight on folder rows
    if (internalDragData) {
      const row = e.target.closest(".fb-row");
      clearDropTargets();
      if (row && row.dataset.type === "directory") {
        row.classList.add("fb-drop-target");
      }
    }
    e.dataTransfer.dropEffect = internalDragData ? (e.altKey ? "copy" : "move") : "copy";
  });

  list.addEventListener("dragleave", (e) => {
    if (internalDragData) {
      clearDropTargets();
      return;
    }
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      hideDropOverlay();
    }
  });

  list.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    hideDropOverlay();
    clearDropTargets();

    // Internal drag: move/copy
    if (internalDragData) {
      const state = store.getState();
      const row = e.target.closest(".fb-row");
      const destination = row && row.dataset.type === "directory"
        ? state.currentPath + "/" + row.dataset.name
        : state.currentPath;

      // Don't move to same location
      if (destination === state.currentPath && !e.altKey) {
        internalDragData = null;
        return;
      }

      const endpoint = e.altKey ? "/api/files/copy" : "/api/files/move";
      try {
        await api.post(endpoint, { items: internalDragData.items, destination });
        await refreshDirectory(store);
      } catch (err) {
        alert(`${e.altKey ? "Copy" : "Move"} failed: ${err.message}`);
      }
      internalDragData = null;
      return;
    }

    // External drag: upload files
    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const state = store.getState();
    for (const file of files) {
      try {
        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        const headers = {
          "X-Target-Dir": state.currentPath,
          "X-Filename": file.name,
        };
        if (csrfMeta?.content) headers["X-CSRF-Token"] = csrfMeta.content;
        await fetch("/api/files/upload", {
          method: "POST",
          headers,
          body: file,
        });
      } catch (err) {
        alert(`Upload failed for ${file.name}: ${err.message}`);
      }
    }
    await refreshDirectory(store);
  });

  // --- Internal drag (move/copy within browser) ---

  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".fb-row");
    if (!row) return;

    const state = store.getState();
    const name = row.dataset.name;
    // If dragging a selected item, drag all selected items
    const names = state.selection.includes(name) ? state.selection : [name];
    const items = names.map(n => state.currentPath + "/" + n);

    internalDragData = { items };
    e.dataTransfer.setData("application/x-katulong-files", JSON.stringify(items));
    e.dataTransfer.effectAllowed = "copyMove";
  });

  list.addEventListener("dragend", () => {
    internalDragData = null;
    clearDropTargets();
  });

  // --- Breadcrumb drop targets ---

  const breadcrumb = container.querySelector(".fb-breadcrumb");
  if (breadcrumb) {
    breadcrumb.addEventListener("dragover", (e) => {
      if (!internalDragData) return;
      e.preventDefault();
      const crumb = e.target.closest(".fb-crumb");
      breadcrumb.querySelectorAll(".fb-crumb").forEach(c => c.classList.remove("fb-drop-target"));
      if (crumb) crumb.classList.add("fb-drop-target");
      e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    });

    breadcrumb.addEventListener("dragleave", () => {
      breadcrumb.querySelectorAll(".fb-crumb").forEach(c => c.classList.remove("fb-drop-target"));
    });

    breadcrumb.addEventListener("drop", async (e) => {
      e.preventDefault();
      breadcrumb.querySelectorAll(".fb-crumb").forEach(c => c.classList.remove("fb-drop-target"));

      if (!internalDragData) return;
      const crumb = e.target.closest(".fb-crumb");
      if (!crumb) return;

      const destination = crumb.dataset.path;
      const endpoint = e.altKey ? "/api/files/copy" : "/api/files/move";
      try {
        await api.post(endpoint, { items: internalDragData.items, destination });
        await refreshDirectory(store);
      } catch (err) {
        alert(`${e.altKey ? "Copy" : "Move"} failed: ${err.message}`);
      }
      internalDragData = null;
    });
  }

  // --- Helpers ---

  function showDropOverlay() {
    if (dropOverlay) return;
    dropOverlay = document.createElement("div");
    dropOverlay.className = "fb-drop-overlay";
    const state = store.getState();
    dropOverlay.textContent = `Upload to ${state.currentPath}`;
    list.style.position = "relative";
    list.appendChild(dropOverlay);
  }

  function hideDropOverlay() {
    if (dropOverlay) {
      dropOverlay.remove();
      dropOverlay = null;
    }
  }

  function clearDropTargets() {
    container.querySelectorAll(".fb-drop-target").forEach(el => el.classList.remove("fb-drop-target"));
  }
}
