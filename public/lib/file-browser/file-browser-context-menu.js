/**
 * File Browser Context Menu
 *
 * Right-click floating menu, positioned at cursor. Context-sensitive based
 * on what was right-clicked (file, folder, background, multi-selection).
 */

/**
 * Create context menu manager.
 * @param {object} options - { onAction }
 *   onAction(action, entry, entries) - called when menu item is clicked
 */
export function createContextMenu(options = {}) {
  const { onAction } = options;
  let menuEl = null;

  function show(e, state) {
    e.preventDefault();
    close();

    const row = e.target.closest(".fb-row");
    const entryName = row ? row.dataset.name : null;
    const entryType = row ? row.dataset.type : null;
    const selection = state.selection;
    const isMulti = selection.length > 1;

    const items = [];

    if (!entryName) {
      // Background click
      items.push({ label: "New Folder", icon: "ph-folder-plus", action: "new-folder" });
      if (state.clipboard) {
        items.push({ label: "Paste", icon: "ph-clipboard-text", action: "paste" });
      }
      items.push({ sep: true });
      items.push({ label: "Upload Files", icon: "ph-upload-simple", action: "upload" });
    } else if (isMulti && selection.includes(entryName)) {
      // Multi-selection
      items.push({ label: `Copy ${selection.length} Items`, icon: "ph-copy", action: "copy" });
      items.push({ label: `Cut ${selection.length} Items`, icon: "ph-scissors", action: "cut" });
      items.push({ sep: true });
      items.push({ label: `Delete ${selection.length} Items`, icon: "ph-trash", action: "delete", danger: true });
    } else {
      // Single item
      if (entryType === "directory") {
        items.push({ label: "Open", icon: "ph-folder-open", action: "open" });
        items.push({ sep: true });
      } else {
        items.push({ label: "Download", icon: "ph-download-simple", action: "download" });
        items.push({ sep: true });
      }
      items.push({ label: "Rename", icon: "ph-pencil-simple", action: "rename" });
      items.push({ label: "Copy", icon: "ph-copy", action: "copy" });
      items.push({ label: "Cut", icon: "ph-scissors", action: "cut" });
      items.push({ sep: true });
      items.push({ label: "Delete", icon: "ph-trash", action: "delete", danger: true });
    }

    menuEl = document.createElement("div");
    menuEl.className = "fb-context-menu";

    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement("div");
        sep.className = "fb-context-sep";
        menuEl.appendChild(sep);
        continue;
      }
      const btn = document.createElement("div");
      btn.className = "fb-context-item" + (item.danger ? " danger" : "");
      btn.innerHTML = `<i class="ph ${item.icon}"></i> ${item.label}`;
      btn.addEventListener("click", () => {
        if (onAction) onAction(item.action, entryName, selection);
        close();
      });
      menuEl.appendChild(btn);
    }

    document.body.appendChild(menuEl);

    // Position at cursor, keep within viewport
    const rect = menuEl.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;

    // Close on next click or escape
    setTimeout(() => {
      document.addEventListener("click", closeOnOutside);
      document.addEventListener("keydown", closeOnEscape);
      document.addEventListener("contextmenu", closeOnOutside);
    }, 0);
  }

  function close() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    document.removeEventListener("click", closeOnOutside);
    document.removeEventListener("keydown", closeOnEscape);
    document.removeEventListener("contextmenu", closeOnOutside);
  }

  function closeOnOutside(e) {
    if (menuEl && !menuEl.contains(e.target)) {
      close();
    }
  }

  function closeOnEscape(e) {
    if (e.key === "Escape") close();
  }

  return { show, close };
}
