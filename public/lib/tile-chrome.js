/**
 * Tile Chrome
 *
 * Creates the chrome zones (toolbar, sidebar, shelf) for a tile card face.
 * Zones collapse to zero size when empty. Each face (front/back) gets its
 * own independent chrome instance.
 *
 * DOM structure:
 *
 *   .card-face
 *     ├── .tile-toolbar     (top bar, hidden when empty)
 *     ├── .tile-body        (middle, flex row)
 *     │   ├── .tile-sidebar (left panel, hidden when empty)
 *     │   └── .tile-content (tile mounts here)
 *     └── .tile-shelf       (bottom bar, hidden when empty)
 */

/**
 * Build the chrome DOM inside a card face and return the API.
 *
 * @param {HTMLElement} faceEl — the .card-face element
 * @returns {{ contentEl: HTMLElement, chrome: TileChrome }}
 */
export function createTileChrome(faceEl) {
  // ── DOM ──────────────────────────────────────────────────────────

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

  const bodyEl = document.createElement("div");
  bodyEl.className = "tile-body";

  const sidebarEl = document.createElement("div");
  sidebarEl.className = "tile-sidebar";

  const contentEl = document.createElement("div");
  contentEl.className = "tile-content";

  bodyEl.appendChild(sidebarEl);
  bodyEl.appendChild(contentEl);

  const shelfEl = document.createElement("div");
  shelfEl.className = "tile-shelf";

  faceEl.appendChild(toolbarEl);
  faceEl.appendChild(bodyEl);
  faceEl.appendChild(shelfEl);

  // ── Visibility tracking ──────────────────────────────────────────

  let toolbarItems = 0;
  let sidebarMounted = false;
  let shelfMounted = false;

  function updateToolbarVisibility() {
    const hasContent = toolbarItems > 0 || toolbarTitle.textContent !== "";
    toolbarEl.classList.toggle("chrome-empty", !hasContent);
  }

  function updateSidebarVisibility() {
    sidebarEl.classList.toggle("chrome-empty", !sidebarMounted);
  }

  function updateShelfVisibility() {
    shelfEl.classList.toggle("chrome-empty", !shelfMounted);
  }

  // Start collapsed
  toolbarEl.classList.add("chrome-empty");
  sidebarEl.classList.add("chrome-empty");
  shelfEl.classList.add("chrome-empty");

  // ── Toolbar API ──────────────────────────────────────────────────

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

  // ── Sidebar API ──────────────────────────────────────────────────

  const sidebar = {
    /**
     * Mount a DOM element into the sidebar.
     * @param {HTMLElement} el
     */
    mount(el) {
      sidebarEl.innerHTML = "";
      sidebarEl.appendChild(el);
      sidebarMounted = true;
      updateSidebarVisibility();
    },

    unmount() {
      sidebarEl.innerHTML = "";
      sidebarMounted = false;
      updateSidebarVisibility();
    },

    setWidth(width) {
      sidebarEl.style.width = width;
      sidebarEl.style.flexShrink = "0";
    },

    collapse() {
      sidebarEl.classList.add("chrome-collapsed");
    },

    expand() {
      sidebarEl.classList.remove("chrome-collapsed");
    },

    get el() { return sidebarEl; },
  };

  // ── Shelf API ────────────────────────────────────────────────────

  const shelf = {
    /**
     * Mount a DOM element into the shelf.
     * @param {HTMLElement} el
     */
    mount(el) {
      shelfEl.innerHTML = "";
      shelfEl.appendChild(el);
      shelfMounted = true;
      updateShelfVisibility();
    },

    unmount() {
      shelfEl.innerHTML = "";
      shelfMounted = false;
      updateShelfVisibility();
    },

    setHeight(height) {
      shelfEl.style.height = height;
      shelfEl.style.flexShrink = "0";
    },

    get el() { return shelfEl; },
  };

  // ── Cleanup ──────────────────────────────────────────────────────

  function destroy() {
    toolbarEl.remove();
    bodyEl.remove();
    shelfEl.remove();
    toolbarItems = 0;
    sidebarMounted = false;
    shelfMounted = false;
  }

  return {
    contentEl,
    chrome: { toolbar, sidebar, shelf },
    destroy,
  };
}
