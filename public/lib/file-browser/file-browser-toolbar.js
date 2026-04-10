/**
 * File Browser Toolbar — composable toolbar factory.
 *
 * Creates the toolbar DOM (nav buttons, breadcrumb, action buttons)
 * and returns { el, update(state) }. The caller wires callbacks;
 * the toolbar knows nothing about the store or nav controller.
 *
 * Breadcrumb uses event delegation (single click listener reading
 * `data-path`) instead of re-attaching handlers on every render.
 */

import { getDeepestPath } from "/lib/file-browser/file-browser-store.js";
import { escapeHtml, escapeAttr } from "/lib/file-browser/file-browser-columns.js";

/**
 * @param {object} callbacks
 * @param {function} callbacks.onBack
 * @param {function} callbacks.onForward
 * @param {function} callbacks.onToggleHidden
 * @param {function} [callbacks.onClose]
 * @param {function} callbacks.onBreadcrumbNav — called with (path: string)
 * @returns {{ el: HTMLElement, update: (state) => void }}
 */
export function createToolbar({ onBack, onForward, onToggleHidden, onClose, onBreadcrumbNav }) {
  const el = document.createElement("div");
  el.className = "fb-toolbar";
  el.innerHTML = `
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
      <button class="fb-btn fb-hidden-btn" aria-label="Toggle hidden files">
        <i class="ph ph-eye-slash"></i>
      </button>
      <button class="fb-btn fb-close-btn" aria-label="Close file browser">
        <i class="ph ph-x"></i>
      </button>
    </div>
  `;

  const backBtn = el.querySelector(".fb-back-btn");
  const fwdBtn = el.querySelector(".fb-forward-btn");
  const hiddenBtn = el.querySelector(".fb-hidden-btn");
  const closeBtn = el.querySelector(".fb-close-btn");
  const breadcrumbEl = el.querySelector(".fb-breadcrumb");

  backBtn.addEventListener("click", onBack);
  fwdBtn.addEventListener("click", onForward);
  hiddenBtn.addEventListener("click", onToggleHidden);
  if (onClose) closeBtn.addEventListener("click", onClose);

  // Event delegation for breadcrumb — one listener, reads data-path
  // from the clicked .fb-crumb element. No re-attach on render.
  breadcrumbEl.addEventListener("click", (e) => {
    const crumb = e.target.closest(".fb-crumb");
    if (crumb?.dataset.path) {
      onBreadcrumbNav(crumb.dataset.path);
    }
  });

  // Track last rendered breadcrumb path to skip no-op updates
  let lastBreadcrumbPath = null;

  function update(state) {
    // Back button: disabled when at root (single column)
    backBtn.disabled = state.columns.length <= 1;

    // Forward button: enabled if last column has a selected directory
    const lastCol = state.columns[state.columns.length - 1];
    const lastSelected = lastCol?.selected;
    const lastEntry = lastSelected && lastCol?.entries.find(e => e.name === lastSelected);
    fwdBtn.disabled = !lastEntry || lastEntry.type !== "directory";

    // Hidden toggle icon
    hiddenBtn.classList.toggle("fb-active", state.showHidden);
    const icon = hiddenBtn.querySelector("i");
    icon.className = state.showHidden ? "ph ph-eye" : "ph ph-eye-slash";

    // Breadcrumb — only rebuild if path changed
    const deepest = getDeepestPath(state);
    if (deepest !== lastBreadcrumbPath) {
      lastBreadcrumbPath = deepest;
      renderBreadcrumb(breadcrumbEl, deepest);
    }
  }

  return { el, update };
}

function renderBreadcrumb(breadcrumbEl, deepest) {
  if (!deepest) {
    breadcrumbEl.innerHTML = "";
    return;
  }

  const parts = deepest.split("/").filter(Boolean);
  let html = `<span class="fb-crumb" data-path="/" data-depth="0">/</span>`;
  let accumulated = "";
  for (let i = 0; i < parts.length; i++) {
    accumulated += "/" + parts[i];
    html += `<span class="fb-crumb-sep">/</span><span class="fb-crumb" data-path="${escapeAttr(accumulated)}" data-depth="${i + 1}">${escapeHtml(parts[i])}</span>`;
  }
  breadcrumbEl.innerHTML = html;
}
