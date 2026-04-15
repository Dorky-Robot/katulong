/**
 * <tile-tab-bar> — Declarative tab bar driven by ui-store.
 *
 * Replaces the imperative getSessionList() → createTabEl() → render()
 * pipeline in shortcut-bar.js. The component subscribes to the ui-store,
 * derives its tab list from state.order + state.tiles via renderer
 * describe(), and dispatches actions (FOCUS_TILE, REORDER, REMOVE_TILE)
 * back into the store. No dual paths, no legacy shims.
 *
 * Platform support: desktop (mouse drag, dblclick rename, contextmenu),
 * tablet (touch drag, long-press context menu, double-tap rename),
 * phone (same layout, CSS handles sizing).
 *
 * Usage:
 *   const bar = document.createElement("tile-tab-bar");
 *   bar.store = uiStore;
 *   bar.addEventListener("tab-close", e => { ... });
 *   bar.addEventListener("tab-add", e => { ... });
 *   container.appendChild(bar);
 */

import { getRenderer } from "/lib/tile-renderers/index.js";
import { detectPlatform } from "/lib/platform.js";

// ── Constants ──────────────────────────────────────────────────────────
const DRAG_DEAD_ZONE = 5;
const LONG_PRESS_MS = 300;
const DRAG_OUT_THRESHOLD = 60;
const DOUBLE_TAP_MS = 300;

// ── Pure derivation ────────────────────────────────────────────────────

/** state → tab descriptors (pure function, no side effects) */
function deriveTabs(state) {
  if (!state?.order) return [];
  return state.order.map(id => {
    const tile = state.tiles[id];
    if (!tile) return null;
    const renderer = getRenderer(tile.type);
    const desc = renderer ? renderer.describe(tile.props) : { title: id, icon: null };
    return {
      id,
      type: tile.type,
      title: desc.title || id,
      icon: desc.icon || "terminal-window",
      active: id === state.focusedId,
    };
  }).filter(Boolean);
}

// ── Web Component ──────────────────────────────────────────────────────

class TileTabBar extends HTMLElement {
  constructor() {
    super();
    this._store = null;
    this._unsubscribe = null;
    this._tabs = [];
    this._drag = null;
    this._touchActive = false;
    this._lastTapId = null;
    this._lastTapTime = 0;
    this._platform = detectPlatform();
    this._rafId = null;
    this._renaming = false;
  }

  // ── Properties ─────────────────────────────────────────────────────

  set store(s) {
    if (this._store === s) return;
    this._unsubscribe?.();
    this._store = s;
    if (s && this.isConnected) this._subscribe();
  }

  get store() { return this._store; }

  // ── Lifecycle ──────────────────────────────────────────────────────

  connectedCallback() {
    this.classList.add("tile-tab-bar");
    if (this._store) this._subscribe();
  }

  disconnectedCallback() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  _subscribe() {
    // Render immediately from current state
    this._renderFromState(this._store.getState());
    // Then subscribe for updates
    this._unsubscribe = this._store.subscribe(() => {
      if (this._renaming) return;
      if (this._drag) return; // defer during drag
      if (this._rafId) return; // coalesce
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        this._renderFromState(this._store.getState());
      });
    });
  }

  // ── Rendering (state → DOM) ────────────────────────────────────────

  _renderFromState(state) {
    this._tabs = deriveTabs(state);
    this._render();
  }

  _render() {
    // Preserve any active rename input
    const activeRename = this.querySelector("input.tab-rename-input");
    const renamingId = activeRename?.closest(".tab-bar-tab")?.dataset.session;

    this.innerHTML = "";

    // Add button
    const addBtn = document.createElement("button");
    addBtn.className = "ipad-add-btn";
    addBtn.tabIndex = -1;
    addBtn.setAttribute("aria-label", "New session");
    addBtn.innerHTML = '<i class="ph ph-plus-circle"></i>';
    addBtn.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("tab-add", { bubbles: true }));
    });

    // Tab row container
    const tabRow = document.createElement("div");
    tabRow.className = "bar-tab-row";
    tabRow.appendChild(addBtn);

    // Scrollable tab area
    const tabArea = document.createElement("div");
    tabArea.className = "tab-scroll-area";

    for (const tab of this._tabs) {
      if (renamingId === tab.id) {
        // Re-insert preserved rename input
        const el = this._createTabEl(tab);
        const label = el.querySelector(".tab-label");
        if (label && activeRename) label.replaceWith(activeRename);
        tabArea.appendChild(el);
      } else {
        tabArea.appendChild(this._createTabEl(tab));
      }
    }

    tabRow.appendChild(tabArea);
    this.appendChild(tabRow);

    // Fit labels after DOM is in place
    requestAnimationFrame(() => this._fitLabels());
  }

  // ── Tab element factory ────────────────────────────────────────────

  _createTabEl(tab) {
    const el = document.createElement("button");
    el.className = "tab-bar-tab" + (tab.active ? " active" : "");
    el.tabIndex = -1;
    el.dataset.session = tab.id;
    el.dataset.type = tab.type;
    el.setAttribute("aria-label", `Tile: ${tab.title}`);

    const icon = document.createElement("i");
    icon.className = `ph ph-${tab.icon}`;
    el.appendChild(icon);

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.title;
    label.dataset.fullName = tab.title;
    el.appendChild(label);

    // ── Event handlers ─────────────────────────────────────────────
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this.startRename(el, tab.id);
    });

    el.addEventListener("contextmenu", (e) => {
      if (this._drag) { e.preventDefault(); return; }
      this._showContextMenu(e, tab);
    });

    el.addEventListener("mousedown", (e) => this._onMouseDown(e, el, tab.id));
    el.addEventListener("touchstart", (e) => this._onTouchStart(e, el, tab.id), { passive: false });

    return el;
  }

  // ── Click / focus ──────────────────────────────────────────────────

  _focusTile(id) {
    if (!this._store) return;
    const state = this._store.getState();
    if (state.focusedId !== id) this._store.focusTile(id);
  }

  // ── Mouse drag ─────────────────────────────────────────────────────

  _onMouseDown(e, tab, id) {
    if (e.button !== 0 || e.target.closest(".tab-close")) return;
    if (this._touchActive || this._drag) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const onMove = (me) => {
      if (this._drag?.isTouch) return;
      me.preventDefault();
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (!started) {
        if (Math.abs(dx) < DRAG_DEAD_ZONE && Math.abs(dy) < DRAG_DEAD_ZONE) return;
        started = true;
        this._beginDrag(tab, id, startX);
      }
      this._updateDrag(me.clientX, me.clientY);
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (this._drag?.isTouch) return;
      if (!started) {
        this._focusTile(id);
        return;
      }
      this._endDrag();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ── Touch drag ─────────────────────────────────────────────────────

  _onTouchStart(e, tab, id) {
    if (e.target.closest(".tab-close")) return;
    const touch = e.touches[0];
    const startX = touch.clientX;
    e.preventDefault();
    this._touchActive = true;
    let started = false;
    let longPressed = false;

    const longPressTimer = setTimeout(() => {
      longPressed = true;
      tab.classList.add("tab-long-press");
    }, LONG_PRESS_MS);

    const onMove = (te) => {
      const t = te.touches[0];
      const dx = t.clientX - startX;
      if (!longPressed && Math.abs(dx) > DRAG_DEAD_ZONE) clearTimeout(longPressTimer);
      if (!started) {
        if (Math.abs(dx) < DRAG_DEAD_ZONE) return;
        started = true;
        clearTimeout(longPressTimer);
        this._beginDrag(tab, id, startX, true);
      }
      te.preventDefault();
      this._updateDrag(t.clientX, t.clientY);
    };

    const onEnd = () => {
      clearTimeout(longPressTimer);
      setTimeout(() => { this._touchActive = false; }, 50);
      tab.classList.remove("tab-long-press");
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
      if (started) {
        this._endDrag();
      } else if (longPressed) {
        const tabDesc = this._tabs.find(t => t.id === id);
        if (tabDesc) this._showContextMenu({ preventDefault() {}, currentTarget: tab }, tabDesc);
      } else {
        const now = Date.now();
        if (this._lastTapId === id && now - this._lastTapTime < DOUBLE_TAP_MS) {
          this._lastTapId = null;
          this._lastTapTime = 0;
          this.startRename(tab, id);
        } else {
          this._lastTapId = id;
          this._lastTapTime = now;
          this._focusTile(id);
        }
      }
    };

    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
  }

  // ── Drag reorder (shared mouse/touch) ──────────────────────────────

  _beginDrag(tab, id, startX, isTouch = false) {
    const tabArea = this.querySelector(".tab-scroll-area");
    if (!tabArea) return;

    const tabs = [...tabArea.querySelectorAll(".tab-bar-tab")];
    const dragIndex = tabs.indexOf(tab);
    if (dragIndex === -1) return;

    // Cache tab rects for swap calculation
    const rects = tabs.map(t => t.getBoundingClientRect());
    const tabRect = rects[dragIndex];

    // Create ghost
    const ghost = tab.cloneNode(true);
    ghost.className = "tab-bar-tab tab-ghost";
    ghost.style.cssText = `
      position: fixed; z-index: 9999; pointer-events: none;
      top: ${tabRect.top}px; left: ${tabRect.left}px;
      width: ${tabRect.width}px; height: ${tabRect.height}px;
      opacity: 0.85;
    `;
    document.body.appendChild(ghost);
    tab.classList.add("tab-dragging");

    this._drag = {
      id, tab, tabs, rects, ghost, startX, isTouch,
      dragIndex, currentIndex: dragIndex, tornOff: false,
    };
  }

  _updateDrag(clientX, clientY) {
    const d = this._drag;
    if (!d) return;

    const dx = clientX - d.startX;
    d.ghost.style.transform = `translateX(${dx}px)`;

    // Tear-off detection (desktop only)
    const tabRect = d.rects[d.dragIndex];
    if (!d.isTouch && clientY > tabRect.bottom + DRAG_OUT_THRESHOLD) {
      d.tornOff = true;
      d.ghost.classList.add("tab-torn-off");
    } else {
      d.tornOff = false;
      d.ghost.classList.remove("tab-torn-off");
    }

    // Swap detection
    const ghostCenter = d.rects[d.dragIndex].left + d.rects[d.dragIndex].width / 2 + dx;
    let newIndex = d.currentIndex;
    for (let i = 0; i < d.rects.length; i++) {
      const r = d.rects[i];
      if (ghostCenter >= r.left && ghostCenter <= r.right) {
        newIndex = i;
        break;
      }
    }

    if (newIndex !== d.currentIndex) {
      d.currentIndex = newIndex;
      // Visual hint: shift tabs
      for (let i = 0; i < d.tabs.length; i++) {
        if (i === d.dragIndex) continue;
        const shift = (i >= Math.min(d.dragIndex, newIndex) && i <= Math.max(d.dragIndex, newIndex))
          ? (newIndex > d.dragIndex ? -d.rects[d.dragIndex].width : d.rects[d.dragIndex].width)
          : 0;
        d.tabs[i].style.transition = "transform 150ms ease";
        d.tabs[i].style.transform = shift ? `translateX(${shift}px)` : "";
      }
    }
  }

  _endDrag() {
    const d = this._drag;
    if (!d) return;
    this._cleanupDrag();

    if (d.tornOff) {
      this.dispatchEvent(new CustomEvent("tab-tear-off", {
        bubbles: true, detail: { id: d.id },
      }));
      return;
    }

    if (d.currentIndex !== d.dragIndex) {
      const ids = d.tabs.map(t => t.dataset.session);
      const [moved] = ids.splice(d.dragIndex, 1);
      ids.splice(d.currentIndex, 0, moved);
      // Single dispatch — ui-store is source of truth
      if (this._store) this._store.reorder(ids);
    }
  }

  _cleanupDrag() {
    if (!this._drag) return;
    if (this._drag.ghost) this._drag.ghost.remove();
    if (this._drag.tab) this._drag.tab.classList.remove("tab-dragging");
    if (this._drag.tabs) {
      for (const t of this._drag.tabs) {
        t.style.transition = "";
        t.style.transform = "";
      }
    }
    this._drag = null;
    // Flush deferred render
    if (this._store) this._renderFromState(this._store.getState());
  }

  // ── Context menu ───────────────────────────────────────────────────

  _showContextMenu(e, tab) {
    e.preventDefault();
    this.dispatchEvent(new CustomEvent("tab-context-menu", {
      bubbles: true,
      detail: {
        id: tab.id,
        type: tab.type,
        title: tab.title,
        x: e.clientX || 0,
        y: e.clientY || 0,
        anchorEl: e.currentTarget,
      },
    }));
  }

  // ── Inline rename ──────────────────────────────────────────────────

  /**
   * Start inline rename on a tab. Public entry point for the host chrome
   * (shortcut-bar's beginRename) — dblclick and context-menu also call this.
   */
  startRename(tabEl, id) {
    const label = tabEl.querySelector(".tab-label");
    if (!label) return;

    this._renaming = true;
    const currentName = label.dataset.fullName || label.textContent;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tab-rename-input";
    input.value = currentName;
    input.style.cssText = `
      background: transparent; border: none; outline: none;
      color: inherit; font: inherit; width: 100%;
      padding: 0; margin: 0;
    `;
    label.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      this._renaming = false;
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        this.dispatchEvent(new CustomEvent("tab-rename", {
          bubbles: true,
          detail: { id, oldName: currentName, newName },
        }));
      }
      // Re-render to reset the label
      if (this._store) this._renderFromState(this._store.getState());
    };

    const revert = () => {
      committed = true;
      this._renaming = false;
      if (this._store) this._renderFromState(this._store.getState());
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); revert(); }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => { if (input.isConnected) commit(); });
    input.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  // ── Tab label truncation ───────────────────────────────────────────

  _fitLabels() {
    const tabArea = this.querySelector(".tab-scroll-area");
    if (!tabArea) return;
    const tabs = [...tabArea.querySelectorAll(".tab-bar-tab")];
    if (tabs.length === 0) return;

    const areaWidth = tabArea.clientWidth;
    const gap = parseFloat(getComputedStyle(tabArea).gap) || 0;
    const totalGap = gap * (tabs.length - 1);
    const availPerTab = Math.floor((areaWidth - totalGap) / tabs.length);

    // Canvas-based text measurement (no reflow)
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    for (const tab of tabs) {
      const label = tab.querySelector(".tab-label");
      if (!label) continue;

      const fullName = label.dataset.fullName || label.textContent;
      const computedFont = getComputedStyle(label).font;
      ctx.font = computedFont;

      const padLeft = parseFloat(getComputedStyle(tab).paddingLeft) || 0;
      const padRight = parseFloat(getComputedStyle(tab).paddingRight) || 0;
      const icon = tab.querySelector("i.ph");
      const iconWidth = icon ? (icon.offsetWidth + 6) : 0;
      const chrome = padLeft + padRight;
      const textBudget = availPerTab - chrome - iconWidth;

      const fullWidth = ctx.measureText(fullName).width;
      if (fullWidth <= textBudget) {
        label.textContent = fullName;
        continue;
      }

      // Middle-ellipsis truncation
      const ellipsis = "\u2026";
      const ellipsisW = ctx.measureText(ellipsis).width;
      const startBudget = (textBudget - ellipsisW) * 0.6;
      const endBudget = (textBudget - ellipsisW) * 0.4;

      const measure = (ch) => ctx.measureText(ch).width;
      let startLen = 0, startW = 0;
      for (let i = 0; i < fullName.length; i++) {
        const w = measure(fullName[i]);
        if (startW + w > startBudget) break;
        startW += w;
        startLen = i + 1;
      }

      let endLen = 0, endW = 0;
      for (let i = fullName.length - 1; i >= startLen; i--) {
        const w = measure(fullName[i]);
        if (endW + w > endBudget) break;
        endW += w;
        endLen++;
      }

      if (startLen > 0 && endLen > 0) {
        label.textContent = fullName.slice(0, startLen) + ellipsis + fullName.slice(-endLen);
      } else if (startLen > 0) {
        label.textContent = fullName.slice(0, startLen) + ellipsis;
      } else {
        label.textContent = fullName[0] || "";
      }
    }
  }
}

// Register the component
customElements.define("tile-tab-bar", TileTabBar);

// Re-fit on window resize
window.addEventListener("resize", () => {
  for (const bar of document.querySelectorAll("tile-tab-bar")) {
    bar._fitLabels();
  }
});

export { TileTabBar, deriveTabs };
