/**
 * File Browser Actions — Miller Columns
 *
 * Handles file operations: rename, new folder, delete, upload, copy/cut/paste.
 * Works with the column-based store.
 */

import { api } from "/lib/api-client.js";
import { refreshAll, getDeepestPath } from "/lib/file-browser/file-browser-store.js";

/**
 * Get the path of the deepest column (where operations target).
 */
function getTargetPath(store) {
  return getDeepestPath(store.getState());
}

/**
 * Find which column contains an entry by name.
 */
function findEntryColumn(store, entryName) {
  const { columns } = store.getState();
  for (let i = columns.length - 1; i >= 0; i--) {
    const entry = columns[i].entries.find(e => e.name === entryName);
    if (entry) return { col: columns[i], index: i, entry };
  }
  return null;
}

/**
 * Upload a single file to a target directory.
 */
export async function uploadFile(targetPath, file) {
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const headers = { "X-Target-Dir": targetPath, "X-Filename": file.name };
  if (csrfMeta?.content) headers["X-CSRF-Token"] = csrfMeta.content;
  const res = await fetch("/api/files/upload", { method: "POST", headers, body: file });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(err.error || `Upload failed (${res.status})`);
  }
}

export function createFileBrowserActions(store) {

  function startRename(container, entryName) {
    const row = container.querySelector(`.fb-miller-row[data-name="${CSS.escape(entryName)}"]`);
    if (!row) return;
    const nameSpan = row.querySelector(".fb-miller-name");
    if (!nameSpan) return;

    const originalText = entryName;
    const found = findEntryColumn(store, entryName);
    if (!found) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "fb-rename-input";
    input.value = originalText;
    nameSpan.textContent = "";
    nameSpan.appendChild(input);
    input.focus();

    const dotIdx = originalText.lastIndexOf(".");
    if (dotIdx > 0) {
      input.setSelectionRange(0, dotIdx);
    } else {
      input.select();
    }

    let committed = false;
    async function commit() {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (!newName || newName === originalText) {
        await refreshAll(store);
        return;
      }
      try {
        await api.post("/api/files/rename", {
          path: found.col.path + "/" + originalText,
          name: newName,
        });
      } catch (err) {
        alert("Rename failed: " + err.message);
      }
      await refreshAll(store);
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); refreshAll(store); }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => commit());
  }

  async function newFolder(container) {
    const targetPath = getTargetPath(store);
    const state = store.getState();
    const lastCol = state.columns[state.columns.length - 1];
    const entries = lastCol ? lastCol.entries : [];

    const name = "untitled folder";
    let finalName = name;
    let counter = 1;
    while (entries.some(e => e.name === finalName)) {
      finalName = `${name} ${counter++}`;
    }

    try {
      await api.post("/api/files/mkdir", { path: targetPath + "/" + finalName });
      await refreshAll(store);
      setTimeout(() => startRename(container, finalName), 50);
    } catch (err) {
      alert("Failed to create folder: " + err.message);
    }
  }

  async function deleteItems(names) {
    const found = findEntryColumn(store, names[0]);
    if (!found) return;
    const paths = names.map(n => found.col.path + "/" + n);
    const hasDir = names.some(n => found.col.entries.find(e => e.name === n)?.type === "directory");
    const msg = names.length === 1
      ? `Delete "${names[0]}"?${hasDir ? " This folder and all its contents will be removed." : ""}`
      : `Delete ${names.length} items?`;

    if (!confirm(msg)) return;

    try {
      await api.post("/api/files/delete", { items: paths });
      await refreshAll(store);
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }

  function uploadFiles(container) {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    container.appendChild(input);

    input.addEventListener("change", async () => {
      const targetPath = getTargetPath(store);
      for (const file of input.files) {
        try {
          await uploadFile(targetPath, file);
        } catch (err) {
          alert(`Upload failed for ${file.name}: ${err.message}`);
        }
      }
      await refreshAll(store);
      input.remove();
    });
    // Clean up if user cancels the file picker
    input.addEventListener("cancel", () => input.remove());

    input.click();
  }

  function downloadFile(entryName) {
    const found = findEntryColumn(store, entryName);
    if (!found) return;
    const filePath = found.col.path + "/" + entryName;
    window.open(`/api/files/download?path=${encodeURIComponent(filePath)}`, "_blank");
  }

  function copyItems(names) {
    const found = findEntryColumn(store, names[0]);
    if (!found) return;
    const items = names.map(n => found.col.path + "/" + n);
    store.dispatch({ type: "SET_CLIPBOARD", clipboard: { action: "copy", items } });
  }

  function cutItems(names) {
    const found = findEntryColumn(store, names[0]);
    if (!found) return;
    const items = names.map(n => found.col.path + "/" + n);
    store.dispatch({ type: "SET_CLIPBOARD", clipboard: { action: "cut", items } });
  }

  async function pasteItems() {
    const state = store.getState();
    if (!state.clipboard) return;
    const targetPath = getTargetPath(store);
    const { action, items } = state.clipboard;
    try {
      if (action === "copy") {
        await api.post("/api/files/copy", { items, destination: targetPath });
      } else {
        await api.post("/api/files/move", { items, destination: targetPath });
        store.dispatch({ type: "SET_CLIPBOARD", clipboard: null });
      }
      await refreshAll(store);
    } catch (err) {
      alert("Paste failed: " + err.message);
    }
  }

  return {
    startRename, newFolder, deleteItems, uploadFiles,
    downloadFile, copyItems, cutItems, pasteItems,
  };
}
