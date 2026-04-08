/**
 * Tile Chrome
 *
 * Builds a toolbar on top of a card face and exposes a small API for
 * mounting the tile's actual content underneath it. Historically this
 * module also owned sidebar and shelf zones, but neither ever had a
 * runtime caller — the only consumer was the (now deleted) plugin
 * SDK documentation. Removed in the terminal-focus refocus so the
 * only chrome concept left is: "title + optional buttons at the top".
 *
 * DOM structure:
 *
 *   .card-face
 *     ├── .tile-toolbar   (top bar, hidden when empty)
 *     └── .tile-content   (tile mounts here, fills remaining space)
 */

/**
 * Build the chrome DOM inside a card face and return the API.
 *
 * @param {HTMLElement} faceEl — the .card-face element
 * @returns {{ contentEl: HTMLElement, chrome: { toolbar: object }, destroy: () => void }}
 */
export function createTileChrome(faceEl) {
  const toolbarEl = document.createElement("div");
  toolbarEl.className = "tile-toolbar";

  const toolbarLeft = document.createElement("div");
  toolbarLeft.className = "tile-toolbar-left";
  const toolbarTitle = document.createElement("span");
  toolbarTitle.className = "tile-toolbar-title";
  const toolbarRight = document.createElement("div");
  toolbarRight.className = "tile-toolbar-right";
  toolbarEl.appendChild(toolbarLeft);
  toolbarEl.appendChild(toolbarTitle);
  toolbarEl.appendChild(toolbarRight);

  const contentEl = document.createElement("div");
  contentEl.className = "tile-content";

  faceEl.appendChild(toolbarEl);
  faceEl.appendChild(contentEl);

  let toolbarItems = 0;

  function updateToolbarVisibility() {
    const hasContent = toolbarItems > 0 || toolbarTitle.textContent !== "";
    toolbarEl.classList.toggle("chrome-empty", !hasContent);
  }

  // Start collapsed — dashboard back tile sets a title on mount; the
  // terminal front face mounts xterm.js directly and leaves the toolbar
  // hidden (xterm draws its own status indicators).
  toolbarEl.classList.add("chrome-empty");

  const toolbar = {
    setTitle(text) {
      toolbarTitle.textContent = text;
      updateToolbarVisibility();
    },

    /**
     * Add a button to the toolbar.
     * @param {object} opts
     * @param {string} opts.icon — Phosphor icon name
     * @param {string} [opts.label] — accessible label
     * @param {string} [opts.position="left"] — "left" or "right"
     * @param {function} opts.onClick
     * @returns {function} remove — call to remove the button
     */
    addButton({ icon, label, position = "left", onClick }) {
      const btn = document.createElement("button");
      btn.className = "tile-toolbar-btn";
      btn.setAttribute("aria-label", label || icon);
      btn.tabIndex = -1;
      btn.innerHTML = `<i class="ph ph-${icon}"></i>`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });

      const container = position === "right" ? toolbarRight : toolbarLeft;
      container.appendChild(btn);
      toolbarItems++;
      updateToolbarVisibility();

      return function remove() {
        btn.remove();
        toolbarItems--;
        updateToolbarVisibility();
      };
    },

    /** Direct access to the toolbar element for advanced use. */
    get el() { return toolbarEl; },
  };

  function destroy() {
    toolbarEl.remove();
    contentEl.remove();
    toolbarItems = 0;
  }

  return {
    contentEl,
    chrome: { toolbar },
    destroy,
  };
}
