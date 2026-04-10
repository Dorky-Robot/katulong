/**
 * File Browser Column Rendering — pure DOM update functions.
 *
 * Given a columns container and state slices, reconcile the DOM.
 * No store references, no subscriptions — the component calls these
 * from its subscribe callback.
 */

import { filterHidden } from "/lib/file-browser/file-browser-store.js";
import { getFileIcon } from "/lib/file-browser/file-browser-types.js";

/**
 * Reconcile column DOM elements and render each column's contents.
 *
 * @param {HTMLElement} columnsEl — the `.fb-columns` container
 * @param {Array} columns — store.getState().columns
 * @param {boolean} showHidden — whether to show dotfiles
 */
export function renderColumns(columnsEl, columns, showHidden) {
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
    renderSingleColumn(colEl, columns[i], i, showHidden);
  }

  // Auto-scroll horizontally so the newly opened column is visible.
  // Why rAF + direct scrollLeft instead of scrollIntoView: the last column
  // has `flex: 1` (so a single-column browser fills the pane). When content
  // overflows, scrollIntoView({inline:"end"}) considers the last column
  // already "in view" because its right edge is flush with the container —
  // nothing scrolls. Writing scrollLeft = scrollWidth after layout settles
  // pins the deepest column to the right edge regardless of flex sizing.
  // Runs on every render (not just count-change) so that drilling deeper
  // via keyboard, or refreshing into a pre-selected deep path, also scrolls.
  if (columns.length > 0) {
    requestAnimationFrame(() => {
      if (columnsEl) columnsEl.scrollLeft = columnsEl.scrollWidth;
    });
  }
}

/**
 * Render a single column's contents: loading spinner, error, empty, or entries.
 */
export function renderSingleColumn(colEl, col, colIndex, showHidden) {
  if (col.loading) {
    colEl.innerHTML = '<div class="fb-miller-loading"><span class="fb-loading-spinner"></span></div>';
    return;
  }
  if (col.error) {
    colEl.innerHTML = `<div class="fb-miller-empty fb-error">${escapeHtml(col.error)}</div>`;
    return;
  }

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

export function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
