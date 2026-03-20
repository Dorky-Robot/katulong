/**
 * Shortcut Bar / Tab Bar Renderer
 *
 * Desktop (fine pointer): browser-like session tabs with close, drag-reorder,
 *   drag-out-to-new-window, plus utility buttons (files, port-forward, settings).
 * Mobile/tablet (coarse/no pointer): session button, Esc/Tab shortcuts, keyboard toggle.
 *
 * Device detection uses pointer capability rather than viewport width so that
 * desktop always gets tabs and mobile/tablet always gets the sidebar layout,
 * regardless of window size.
 */

import { keysToSequence, sendSequence } from "/lib/key-mapping.js";
import { invalidateSessions } from "/lib/stores.js";
import { api } from "/lib/api-client.js";

const DESKTOP_MQ = "(pointer: fine)";
const TABLET_MQ = "(pointer: coarse) and (min-width: 768px)";
const TABLET_ANY_MQ = "(any-pointer: coarse) and (min-width: 768px)";
const DRAG_OUT_THRESHOLD = 60; // px below bar to trigger tear-off (desktop)
const SPLIT_THRESHOLD = 15; // px below bar to trigger split preview (tablet)
const DRAG_DEAD_ZONE = 5; // px before drag starts
const LONG_PRESS_MS = 300; // ms before touch becomes drag

/**
 * Create shortcut bar renderer
 */
export function createShortcutBar(options = {}) {
  const {
    container,
    pinnedKeys = [
      { label: "Esc", keys: "esc" },
      { label: "Tab", keys: "tab" }
    ],
    onSessionClick,
    onNewSessionClick,
    onTabClick,
    onTabRenamed,
    onAdoptSession,
    onTerminalClick,
    onFilesClick,
    onPortForwardClick,
    onSettingsClick,
    onShortcutsClick,
    onDictationClick,
    onNotepadClick,
    onAllTabsClosed,
    onSplitDrop,
    sendFn,
    updateConnectionIndicator,
    getInstanceIcon,
    getSessionIcon,
    sessionStore,
    windowTabSet,
    splitManager,
  } = options;

  let currentSessionName = "";
  let portProxyEnabled = true;
  let activeMenu = null; // currently open context/dropdown menu

  function isDesktop() {
    if (window.matchMedia(DESKTOP_MQ).matches || window.matchMedia(TABLET_MQ).matches || window.matchMedia(TABLET_ANY_MQ).matches) return true;
    // Always use desktop tabs on iPad, even in narrow multitasking windows
    const ua = navigator.userAgent || "";
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return true;
    return false;
  }

  function isTouch() {
    return window.matchMedia("(pointer: coarse)").matches;
  }

  /** Detect iPad/tablet: same logic as split-manager's detectTablet */
  function isTabletLocal() {
    if (navigator.maxTouchPoints === 0 || window.innerWidth < 768) return false;
    const ua = navigator.userAgent || "";
    const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const isAndroidTablet = /Android/.test(ua) && !/Mobile/.test(ua);
    return isIPad || isAndroidTablet;
  }

  function isPhone() {
    return isTouch() && !window.matchMedia(TABLET_MQ).matches;
  }

  function safeInstanceIcon() {
    const raw = getInstanceIcon ? getInstanceIcon() : "terminal-window";
    return raw.replace(/[^a-z0-9-]/g, "");
  }

  /** Get the icon for a specific session (per-session override or instance default) */
  function iconForSession(sessionName) {
    if (getSessionIcon) {
      const override = getSessionIcon(sessionName);
      if (override) return override.replace(/[^a-z0-9-]/g, "");
    }
    return safeInstanceIcon();
  }

  // ── Context menu / dropdown ────────────────────────────────────────

  function closeMenu() {
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
    document.removeEventListener("click", onDocClickCloseMenu, true);
  }

  function onDocClickCloseMenu(e) {
    if (activeMenu && !activeMenu.contains(e.target)) {
      closeMenu();
    }
  }

  function showMenu(items, anchorEl) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "tab-context-menu";

    for (const item of items) {
      if (item.divider) {
        const hr = document.createElement("div");
        hr.className = "tab-menu-divider";
        if (item.label) {
          hr.classList.add("tab-menu-divider-label");
          hr.textContent = item.label;
        }
        menu.appendChild(hr);
        continue;
      }
      const row = document.createElement("button");
      row.className = "tab-menu-item" + (item.danger ? " danger" : "");

      const iconEl = document.createElement("i");
      iconEl.className = `ph ph-${item.icon}`;
      if (item.iconColor) iconEl.style.color = item.iconColor;
      row.appendChild(iconEl);

      const label = document.createElement("span");
      label.textContent = item.label;
      row.appendChild(label);

      if (item.deleteAction) {
        const delBtn = document.createElement("span");
        delBtn.className = "tab-menu-delete";
        delBtn.innerHTML = '<i class="ph ph-trash"></i>';
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          // Remove item from menu with slide-out animation
          row.style.pointerEvents = "none";
          row.style.transition = "opacity 0.2s, max-height 0.2s, padding 0.2s, margin 0.2s";
          row.style.overflow = "hidden";
          row.style.maxHeight = row.offsetHeight + "px";
          requestAnimationFrame(() => {
            row.style.opacity = "0";
            row.style.maxHeight = "0";
            row.style.padding = "0 0.75rem";
          });
          setTimeout(() => row.remove(), 250);
          item.deleteAction(row);
        });
        row.appendChild(delBtn);
      }

      row.addEventListener("click", (e) => {
        if (e.target.closest(".tab-menu-delete")) return;
        e.stopPropagation();
        closeMenu();
        item.action();
      });
      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    activeMenu = menu;

    // Position below anchor (after layout so measurements are valid)
    requestAnimationFrame(() => {
      const rect = anchorEl.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      let left = rect.left;
      // Keep menu within viewport
      if (left + menuRect.width > window.innerWidth - 8) {
        left = window.innerWidth - menuRect.width - 8;
      }
      menu.style.left = Math.max(8, left) + "px";
      menu.style.top = rect.bottom + 4 + "px";

      document.addEventListener("click", onDocClickCloseMenu, true);
    });
  }

  function deleteUnmanagedSession(name) {
    api.delete(`/tmux-sessions/${encodeURIComponent(name)}`).then(() => {
      if (sessionStore) invalidateSessions(sessionStore, currentSessionName);
    }).catch(err => {
      console.error("[Session] Delete failed:", err);
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** Open a session in a new window with only that tab in its tab set */
  function openInNewWindow(name) {
    const url = `${location.origin}/?s=${encodeURIComponent(name)}`;
    // Temporarily set sessionStorage so the new window inherits only this tab
    // (window.open copies the opener's sessionStorage to the new context)
    const savedTabs = sessionStorage.getItem("katulong-window-tabs");
    const savedWindowId = sessionStorage.getItem("katulong-window-id");
    sessionStorage.setItem("katulong-window-tabs", JSON.stringify([name]));
    sessionStorage.removeItem("katulong-window-id");
    try {
      window.open(url, "_blank", "width=900,height=600");
    } finally {
      if (savedTabs) sessionStorage.setItem("katulong-window-tabs", savedTabs);
      else sessionStorage.removeItem("katulong-window-tabs");
      if (savedWindowId) sessionStorage.setItem("katulong-window-id", savedWindowId);
    }
  }

  // ── Tab actions ────────────────────────────────────────────────────

  /** After removing a tab, navigate to the nearest remaining tab or "/" */
  function navigateAfterRemoval(removedName, priorIndex) {
    const remaining = windowTabSet ? windowTabSet.getTabs() : [];
    if (removedName !== currentSessionName) { render(currentSessionName); return; }
    if (remaining.length > 0) {
      const idx = typeof priorIndex === "number" ? priorIndex : 0;
      if (onTabClick) onTabClick(remaining[Math.min(idx, remaining.length - 1)]);
      return;
    }
    // No tabs left in this window — mark empty state and reload
    sessionStorage.setItem("katulong-empty-state", "1");
    window.location.href = "/";
  }

  /** Close tab: remove from this window's tab set only (session stays managed on server) */
  function closeTab(sessionName) {
    if (!windowTabSet) return;
    const idx = windowTabSet.getTabs().indexOf(sessionName);
    windowTabSet.removeTab(sessionName);
    navigateAfterRemoval(sessionName, idx);
  }

  async function detachTab(sessionName) {
    try {
      await api.delete(`/sessions/${encodeURIComponent(sessionName)}?action=detach`);
    } catch (err) {
      console.error("[Tab] Detach failed:", err);
      return;
    }
    const idx = windowTabSet ? windowTabSet.getTabs().indexOf(sessionName) : 0;
    if (windowTabSet) windowTabSet.removeTab(sessionName);
    navigateAfterRemoval(sessionName, idx);
  }

  async function killTab(sessionName) {
    if (!confirm(`Kill session "${sessionName}"?\n\nThis will terminate the tmux session and all its processes.`)) return;
    try {
      await api.delete(`/sessions/${encodeURIComponent(sessionName)}`);
    } catch (err) {
      console.error("[Tab] Kill failed:", err);
      return;
    }
    const idx = windowTabSet ? windowTabSet.getTabs().indexOf(sessionName) : 0;
    if (windowTabSet) windowTabSet.onSessionKilled(sessionName);
    navigateAfterRemoval(sessionName, idx);
  }

  /**
   * Show right-click context menu on a tab
   */
  function showTabContextMenu(e, sessionName) {
    e.preventDefault();
    const tab = e.currentTarget;
    const items = [
      {
        icon: "note-pencil",
        label: "Notes",
        action: () => { if (onNotepadClick) onNotepadClick(); }
      },
      {
        icon: "pencil-simple",
        label: "Rename",
        action: () => startTabRename(tab, sessionName)
      },
      {
        icon: "eject",
        label: "Detach from server",
        action: () => detachTab(sessionName)
      },
      {
        icon: "x-circle",
        label: "Kill session",
        danger: true,
        action: () => killTab(sessionName)
      },
      { divider: true },
      {
        icon: "arrow-square-out",
        label: "Open in new window",
        action: () => {
          openInNewWindow(sessionName);
          closeTab(sessionName);
        }
      }
    ];
    showMenu(items, tab);
  }

  /**
   * Show + button dropdown: new session + all tmux sessions not open as tabs
   */
  async function showAddMenu(addBtn) {
    // Fetch managed sessions and unmanaged tmux sessions in parallel
    let managed = [];
    let unmanaged = [];
    try {
      const [sessData, tmuxData] = await Promise.all([
        api.get(`/sessions?_t=${Date.now()}`),
        api.get(`/tmux-sessions?_t=${Date.now()}`),
      ]);
      managed = sessData || [];
      unmanaged = (tmuxData || []).map(s => typeof s === "string" ? { name: s, attached: false } : s);
    } catch (err) { console.error("[showAddMenu] fetch error:", err); }

    const openTabs = windowTabSet ? new Set(windowTabSet.getTabs()) : new Set();

    const items = [
      {
        icon: "plus",
        label: "New session",
        action: () => { if (onNewSessionClick) onNewSessionClick(); }
      }
    ];

    // Managed sessions not open as tabs in this window
    const closedManaged = managed.filter(s => !openTabs.has(s.name));
    // Unmanaged tmux sessions (not managed by katulong)
    if (closedManaged.length > 0 || unmanaged.length > 0) {
      items.push({ divider: true, label: "Sessions" });
      for (const s of closedManaged) {
        items.push({
          icon: "terminal-window",
          iconColor: "var(--success)",
          label: s.name,
          action: () => {
            if (windowTabSet) windowTabSet.addTab(s.name);
            if (onTabClick) onTabClick(s.name);
          },
          deleteAction: () => {
            if (!confirm(`Kill session "${s.name}"?\n\nThis will terminate the tmux session and all its processes.`)) return;
            api.delete(`/sessions/${encodeURIComponent(s.name)}`).then(() => {
              if (windowTabSet) windowTabSet.onSessionKilled(s.name);
              if (sessionStore) invalidateSessions(sessionStore, currentSessionName);
              if (s.name === currentSessionName) navigateAfterRemoval(s.name, 0);
            }).catch(err => console.error("[Session] Kill failed:", err));
          },
        });
      }
      for (const s of unmanaged) {
        const item = {
          icon: s.attached ? "link" : "plug",
          label: s.name + (s.attached ? " (attached)" : ""),
          action: () => {
            if (onAdoptSession) onAdoptSession(s.name);
          },
        };
        item.deleteAction = () => {
          const msg = s.attached
            ? `"${s.name}" has attached clients. Kill it anyway?`
            : `Kill tmux session "${s.name}"?`;
          if (!confirm(msg)) return;
          deleteUnmanagedSession(s.name);
        };
        items.push(item);
      }
    }

    showMenu(items, addBtn);
  }

  // ── Inline tab rename ─────────────────────────────────────────────

  function startTabRename(tab, sessionName) {
    const label = tab.querySelector(".tab-label");
    if (!label || tab.querySelector(".tab-rename-input")) return;

    const input = document.createElement("input");
    input.className = "tab-rename-input";
    input.value = sessionName;
    input.setAttribute("aria-label", "Rename session");

    // Select all text for easy replacement
    label.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;

    function commit() {
      if (committed) return;
      committed = true;

      const newName = input.value.trim();
      if (!newName || newName === sessionName) {
        revert();
        return;
      }

      // Call rename API
      api.put(`/sessions/${encodeURIComponent(sessionName)}`, { name: newName })
        .then((result) => {
          const canonicalName = result?.name || newName;
          if (onTabRenamed) onTabRenamed(sessionName, canonicalName);
        })
        .catch((err) => {
          console.error("[Tab] Rename failed:", err);
          // Input may be detached if render() fired during the API call
          render(currentSessionName);
        });
    }

    function revert() {
      committed = true;
      const span = document.createElement("span");
      span.className = "tab-label";
      span.textContent = sessionName;
      if (input.parentNode) input.replaceWith(span);
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); if (!committed) revert(); }
      e.stopPropagation(); // Don't let keyboard events reach the terminal
    });
    // Only commit on blur if input is still connected (not detached by render())
    input.addEventListener("blur", () => { if (input.isConnected) commit(); });
    // Prevent mousedown from starting a tab drag
    input.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  // ── Chrome-style drag reorder ──────────────────────────────────────

  let drag = null;

  function onTabMouseDown(e, tab, name) {
    if (e.button !== 0 || e.target.closest(".tab-close")) return;
    // If a touch drag is already in progress, don't start a mouse drag too.
    // iPad Safari synthesizes mouse events from touch, which would create
    // a second competing drag that makes the ghost jump around.
    if (drag) return;

    // On iPad, synthesized mouse events from touch trigger native text
    // selection / drag unless we prevent default immediately.
    if (splitManager?.isTablet()) {
      e.preventDefault();
    }

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const onMove = (me) => {
      me.preventDefault(); // prevent native selection during drag
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;

      if (!started) {
        if (Math.abs(dx) < DRAG_DEAD_ZONE && Math.abs(dy) < DRAG_DEAD_ZONE) return;
        started = true;
        beginDrag(tab, name, startX);
      }

      updateDrag(me.clientX, me.clientY);
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      if (!started) {
        if (splitManager?.isSplit() || name !== currentSessionName) {
          if (onTabClick) onTabClick(name);
        }
        return;
      }

      endDrag();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function onTabTouchStart(e, tab, name) {
    if (e.target.closest(".tab-close")) return;

    // On iPad, prevent default immediately to suppress native drag/selection
    // gestures that fight with our custom drag and cause jittery movement.
    if (splitManager?.isTablet()) {
      e.preventDefault();
    }

    // Long-press to drag: short touches allow native horizontal scroll of the tab area.
    // After LONG_PRESS_MS without significant movement, we enter drag mode.
    const initialTouch = e.touches[0];
    const startX = initialTouch.clientX;
    const startY = initialTouch.clientY;
    let longPressed = false;
    let started = false;
    let cancelled = false;

    const longPressTimer = setTimeout(() => {
      longPressed = true;
      tab.classList.add("tab-long-press");
    }, LONG_PRESS_MS);

    const onMove = (te) => {
      const touch = te.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!longPressed) {
        // Movement before long press — cancel drag, allow native scroll
        if (Math.abs(dx) > DRAG_DEAD_ZONE || Math.abs(dy) > DRAG_DEAD_ZONE) {
          clearTimeout(longPressTimer);
          cancelled = true;
          cleanup();
        }
        return;
      }

      // Long press active — enter drag mode
      if (!started) {
        if (Math.abs(dx) < DRAG_DEAD_ZONE && Math.abs(dy) < DRAG_DEAD_ZONE) return;
        started = true;
        beginDrag(tab, name, startX, true);
      }

      te.preventDefault();
      updateDrag(touch.clientX, touch.clientY);
    };

    const onEnd = () => {
      clearTimeout(longPressTimer);
      tab.classList.remove("tab-long-press");
      cleanup();

      if (cancelled) return;

      if (!started) {
        if (longPressed) {
          // Long press without drag — show context menu
          showTabContextMenu({ preventDefault() {}, currentTarget: tab }, name);
        } else if (splitManager?.isSplit() || name !== currentSessionName) {
          if (onTabClick) onTabClick(name);
        }
        return;
      }

      endDrag();
    };

    function cleanup() {
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    }

    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
  }

  function beginDrag(tab, name, startX, fromTouch) {
    const tabs = [...container.querySelectorAll(".tab-bar-tab")];
    const dragIndex = tabs.indexOf(tab);
    if (dragIndex === -1) return; // tab removed from DOM between touchstart and drag

    const rects = tabs.map(t => {
      const r = t.getBoundingClientRect();
      return { left: r.left, width: r.width, center: r.left + r.width / 2 };
    });

    const ghost = tab.cloneNode(true);
    ghost.classList.add("tab-drag-ghost");
    ghost.style.width = rects[dragIndex].width + "px";
    ghost.style.height = tab.offsetHeight + "px";
    // Safari clips cloned nodes that inherit overflow:hidden from the source tab,
    // even after appending to document.body with position:fixed. Force visible.
    ghost.style.overflow = "visible";
    document.body.appendChild(ghost);

    tab.classList.add("tab-dragging");

    tabs.forEach((t, i) => {
      if (i !== dragIndex) t.style.transition = "transform 0.2s ease";
    });

    const grabOffset = startX - rects[dragIndex].left;

    // Cache ghost height and bar rect to avoid forced layout reflows every frame
    const ghostHeight = ghost.offsetHeight;
    const barRectCached = container.getBoundingClientRect();
    const isTabletCached = splitManager?.isTablet() || isTabletLocal();

    drag = {
      tab, name, ghost, tabs, rects, dragIndex,
      currentIndex: dragIndex,
      grabOffset,
      ghostHeight,
      barBottom: barRectCached.bottom,
      barLeft: barRectCached.left,
      barWidth: barRectCached.width,
      isTabletCached,
      tornOff: false,
      isTouch: !!fromTouch,
    };
  }

  function updateDrag(cx, cy) {
    if (!drag) return;
    const { ghost, tabs, rects, dragIndex, grabOffset, ghostHeight } = drag;

    // Use translate3d for GPU-accelerated positioning (no layout reflows)
    const gx = cx - grabOffset;
    const gy = cy - ghostHeight / 2;
    ghost.style.transform = drag.tornOff
      ? `translate3d(${gx}px, ${gy}px, 0) scale(1.08)`
      : `translate3d(${gx}px, ${gy}px, 0)`;

    // Track last position for cross-pane transfer detection in endDrag
    drag.lastCx = cx;
    drag.lastCy = cy;

    // Use cached values — no getBoundingClientRect() in the hot path
    const isTabletDevice = drag.isTabletCached;
    const belowBar = cy > drag.barBottom + SPLIT_THRESHOLD;

    // iPad/tablet: drag below bar enters split preview (replaces tear-off).
    if (isTabletDevice && splitManager && !splitManager.isSplit() && belowBar) {
      if (!drag.splitPreview) {
        drag.splitPreview = true;
        ghost.classList.add("tab-tear-off");
        tabs.forEach((t, i) => { if (i !== dragIndex) t.style.transform = ""; });

        // Build the split overlay directly here (inline) so it's guaranteed to render.
        const tc = document.getElementById("terminal-container");
        const dir = window.matchMedia("(orientation: landscape)").matches ? "row" : "column";
        const overlay = document.createElement("div");
        overlay.id = "split-overlay";
        overlay.className = "split-overlay overlay-" + dir;
        for (let i = 0; i < 2; i++) {
          const zone = document.createElement("div");
          zone.dataset.pane = String(i + 1);
          zone.className = "split-zone";
          const label = document.createElement("div");
          label.textContent = i === 0 ? "\u25C0 Drop here" : "Drop here \u25B6";
          zone.appendChild(label);
          overlay.appendChild(zone);
        }
        tc.appendChild(overlay);
        // Dim the active terminal pane
        const activePane = tc.querySelector(".terminal-pane.active");
        if (activePane) activePane.classList.add("split-dimmed");
        drag.splitOverlayEl = overlay;
        drag.splitActivePane = activePane;
      }

      // Update hover state on zones
      const overlay = drag.splitOverlayEl;
      if (overlay) {
        const tcRect = document.getElementById("terminal-container").getBoundingClientRect();
        const dir = window.matchMedia("(orientation: landscape)").matches ? "row" : "column";
        const zones = overlay.children;
        let hoverPane;
        if (dir === "row") {
          hoverPane = cx < tcRect.left + tcRect.width / 2 ? 1 : 2;
        } else {
          hoverPane = cy < tcRect.top + tcRect.height / 2 ? 1 : 2;
        }
        for (let i = 0; i < zones.length; i++) {
          const isHover = (i + 1) === hoverPane;
          zones[i].classList.toggle("hover", isHover);
        }
        drag.splitHoverPane = hoverPane;
      }
      return;
    }
    // Once split preview is active, keep it open even if the finger drifts
    // slightly above the threshold (iOS touch imprecision on lift).
    // The preview stays until endDrag — just stop updating the hover zone.
    if (drag.splitPreview) {
      return;
    }

    // When split is active, skip tab reorder shifts — just let the ghost follow
    // the finger. Cross-pane transfer is handled in endDrag based on drop position.
    if (splitManager?.isSplit()) {
      return;
    }

    // Tear-off only for mouse on non-tablet — touch can't open new windows (Safari blocks popups)
    if (!isTabletDevice && !drag.isTouch && cy > drag.barBottom + DRAG_OUT_THRESHOLD) {
      if (!drag.tornOff) {
        drag.tornOff = true;
        ghost.classList.add("tab-tear-off");
        tabs.forEach((t, i) => { if (i !== dragIndex) t.style.transform = ""; });
      }
      return;
    }
    if (drag.tornOff) {
      drag.tornOff = false;
      ghost.classList.remove("tab-tear-off");
    }

    const dragWidth = rects[dragIndex].width;

    let newIndex = rects.length - 1;
    for (let i = 0; i < rects.length; i++) {
      if (cx < rects[i].center) {
        newIndex = i;
        break;
      }
    }
    if (newIndex > rects.length - 1) newIndex = rects.length - 1;

    drag.currentIndex = newIndex;

    for (let i = 0; i < tabs.length; i++) {
      if (i === dragIndex) continue;

      let shift = 0;
      if (dragIndex < newIndex) {
        if (i > dragIndex && i <= newIndex) {
          shift = -(dragWidth + getGap());
        }
      } else if (dragIndex > newIndex) {
        if (i >= newIndex && i < dragIndex) {
          shift = dragWidth + getGap();
        }
      }

      tabs[i].style.transform = shift ? `translateX(${shift}px)` : "";
    }
  }

  function getGap() {
    const area = container.querySelector(".tab-scroll-area") || container;
    return parseFloat(getComputedStyle(area).gap) || 0;
  }

  /** Clean up all drag state: ghost, overlay, dimmed pane, stale refs */
  function cleanupDrag() {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    if (drag.tab) drag.tab.classList.remove("tab-dragging");
    if (drag.tabs) drag.tabs.forEach(t => { t.style.transition = ""; t.style.transform = ""; });
    // Clean up split overlay
    if (drag.splitOverlayEl) drag.splitOverlayEl.remove();
    if (drag.splitActivePane) drag.splitActivePane.classList.remove("split-dimmed");
    // Remove any orphaned overlay by ID
    document.getElementById("split-overlay")?.remove();
    drag = null;
  }

  function endDrag() {
    if (!drag) return;
    const { name, dragIndex, currentIndex, tornOff } = drag;

    // Extract split state before cleanup
    const wasSplitPreview = drag.splitPreview;
    const splitHoverPane = drag.splitHoverPane;
    const lastCx = drag.lastCx;

    cleanupDrag();

    // Split drop: tab was dragged to a split zone on iPad (initial split creation)
    if (wasSplitPreview && splitHoverPane) {
      if (onSplitDrop) onSplitDrop(name, splitHoverPane);
      render(currentSessionName);
      return;
    }

    // Cross-pane transfer: drag a tab past the divider to move it to the other pane
    if (splitManager?.isSplit() && lastCx != null) {
      const barRect = container.getBoundingClientRect();
      const barMid = barRect.left + barRect.width / 2;
      const currentPane = splitManager.getPaneForSession(name);
      const targetPane = lastCx > barMid ? 2 : 1;

      if (targetPane !== currentPane) {
        // Move tab to the other pane
        if (targetPane === 2) {
          splitManager.addToPane2(name);
        } else {
          splitManager.removeFromPane2(name);
        }

        // Check if the old pane has any remaining tabs
        const allTabs = windowTabSet ? windowTabSet.getTabs() : [];
        const oldPaneTabs = allTabs.filter(t => t !== name &&
          (currentPane === 1 ? !splitManager.isInPane2(t) : splitManager.isInPane2(t)));

        if (oldPaneTabs.length === 0) {
          // No tabs left in old pane — unsplit, keeping the transferred tab's pane
          splitManager.unsplit(name);
          render(currentSessionName);
          return;
        }

        // If this tab was the active session in its old pane, switch that pane
        const oldPaneActive = currentPane === 1 ? splitManager.getPane1() : splitManager.getPane2();
        if (oldPaneActive === name) {
          splitManager.switchPaneSession(currentPane, oldPaneTabs[0]);
        }

        // Make the transferred tab active in the target pane
        splitManager.switchPaneSession(targetPane, name);
        render(currentSessionName);
        return;
      }
    }

    if (tornOff) {
      openInNewWindow(name);
      closeTab(name);
    } else if (currentIndex !== dragIndex) {
      const names = tabs.map(t => t.dataset.session);
      const [moved] = names.splice(dragIndex, 1);
      names.splice(currentIndex, 0, moved);
      if (windowTabSet) {
        windowTabSet.reorderTabs(names);
      }
    }

    drag = null;

    render(currentSessionName);
  }

  // ── Render ─────────────────────────────────────────────────────────

  /** Create a single tab button element */
  function createTabEl(s, isActive, paneClass) {
    const tab = document.createElement("button");
    tab.className = "tab-bar-tab" + (isActive ? " active" : "") + (paneClass ? ` ${paneClass}` : "");
    tab.tabIndex = -1;
    tab.dataset.session = s.name;
    tab.setAttribute("aria-label", `Session: ${s.name}`);

    const iconEl = document.createElement("i");
    iconEl.className = `ph ph-${iconForSession(s.name)}`;
    tab.appendChild(iconEl);

    const nameSpan = document.createElement("span");
    nameSpan.className = "tab-label";
    nameSpan.textContent = s.name;
    tab.appendChild(nameSpan);

    // Notes indicator dot
    if (options.notepad && options.notepad.hasNotes(s.name)) {
      const dot = document.createElement("span");
      dot.className = "tab-notes-dot";
      dot.title = "Has notes";
      tab.appendChild(dot);
    }

    // Close button (×)
    const closeBtn = document.createElement("span");
    closeBtn.className = "tab-close";
    closeBtn.setAttribute("aria-label", `Close ${s.name}`);
    closeBtn.innerHTML = '<i class="ph ph-x"></i>';
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // When split, closing the last tab in a pane unsplits
      if (splitManager?.isSplit()) {
        const pane = splitManager.getPaneForSession(s.name);
        const paneActive = pane === 1 ? splitManager.getPane1() : splitManager.getPane2();
        if (s.name === paneActive) {
          // Closing the active session in this pane — unsplit
          const otherSession = splitManager.getOtherSession(s.name);
          splitManager.unsplit(otherSession);
          if (windowTabSet) windowTabSet.removeTab(s.name);
          render(otherSession);
          return;
        }
      }
      closeTab(s.name);
    });
    tab.appendChild(closeBtn);

    // Double-click to rename
    tab.addEventListener("dblclick", (e) => {
      e.preventDefault();
      startTabRename(tab, s.name);
    });

    // Right-click context menu
    tab.addEventListener("contextmenu", (e) => {
      // Suppress context menu during drag (iOS fires contextmenu on long press)
      if (drag) { e.preventDefault(); return; }
      showTabContextMenu(e, s.name);
    });

    // Drag-reorder / click-to-switch
    tab.addEventListener("mousedown", (e) => onTabMouseDown(e, tab, s.name));
    tab.addEventListener("touchstart", (e) => onTabTouchStart(e, tab, s.name), { passive: false });

    return tab;
  }

  function renderDesktopTabs(sessionName, sessions) {

    const isSplit = splitManager?.isSplit();

    if (isSplit) {
      // Split mode: two separate tab groups, one per pane
      const dir = splitManager.getDirection();
      const isRow = dir === "row";
      const p1Active = splitManager.getPane1();
      const p2Active = splitManager.getPane2();
      const pane1Tabs = sessions.filter(s => !splitManager.isInPane2(s.name));
      const pane2Tabs = sessions.filter(s => splitManager.isInPane2(s.name));

      // Remove any previous pane 2 tab bar from the terminal container
      const existingPane2Tabs = document.querySelector(".split-pane-2 .split-pane-tabs");
      if (existingPane2Tabs) existingPane2Tabs.innerHTML = "";

      // Helper: build a tab group with + button
      function buildTabGroup(tabs, activeSession) {
        const group = document.createElement("div");
        group.className = "tab-scroll-area";
        for (const s of tabs) {
          group.appendChild(createTabEl(s, s.name === activeSession));
        }
        const addBtn = document.createElement("button");
        addBtn.className = "tab-bar-add";
        addBtn.tabIndex = -1;
        addBtn.setAttribute("aria-label", "New session");
        addBtn.innerHTML = '<i class="ph ph-plus-circle"></i>';
        addBtn.addEventListener("click", () => showAddMenu(addBtn));
        group.appendChild(addBtn);
        return group;
      }

      if (isRow) {
        // Landscape: both tab groups side by side in the shortcut bar
        const splitBar = document.createElement("div");
        splitBar.style.cssText = "display:flex; flex:1; min-width:0; gap:0;";

        const group1 = buildTabGroup(pane1Tabs, p1Active);
        group1.style.cssText += "flex:1; min-width:0; border-right:2px solid var(--accent-active);";
        splitBar.appendChild(group1);

        const group2 = buildTabGroup(pane2Tabs, p2Active);
        group2.style.cssText += "flex:1; min-width:0; padding-left:var(--space-xs);";
        splitBar.appendChild(group2);

        container.appendChild(splitBar);
      } else {
        // Portrait: pane 1 tabs in the shortcut bar, pane 2 tabs populated
        // in the .split-pane-tabs element that split-manager created inside .split-pane-2
        const group1 = buildTabGroup(pane1Tabs, p1Active);
        container.appendChild(group1);

        const pane2TabsEl = document.querySelector(".split-pane-2 .split-pane-tabs");
        if (pane2TabsEl) {
          const pane2Bar = buildTabGroup(pane2Tabs, p2Active);
          // Move children from the built group into the split-pane-tabs element
          while (pane2Bar.firstChild) {
            pane2TabsEl.appendChild(pane2Bar.firstChild);
          }
        }
      }
    } else {
      // Normal mode: single tab group
      const tabScroll = document.createElement("div");
      tabScroll.className = "tab-scroll-area";

      for (const s of sessions) {
        tabScroll.appendChild(createTabEl(s, s.name === sessionName));
      }

      const addBtn = document.createElement("button");
      addBtn.className = "tab-bar-add";
      addBtn.tabIndex = -1;
      addBtn.setAttribute("aria-label", "New session");
      addBtn.innerHTML = '<i class="ph ph-plus-circle"></i>';
      addBtn.addEventListener("click", () => showAddMenu(addBtn));
      tabScroll.appendChild(addBtn);

      container.appendChild(tabScroll);
    }

  }

  function renderMobile(sessionName) {
    const sessBtn = document.createElement("button");
    sessBtn.className = "session-btn";
    sessBtn.tabIndex = -1;
    sessBtn.setAttribute("aria-label", `Session: ${sessionName}`);
    const iconEl = document.createElement("i");
    iconEl.className = `ph ph-${iconForSession(sessionName)}`;
    sessBtn.appendChild(iconEl);
    sessBtn.appendChild(document.createTextNode(" "));
    sessBtn.appendChild(document.createTextNode(sessionName));
    if (onSessionClick) {
      sessBtn.addEventListener("click", onSessionClick);
    }
    container.appendChild(sessBtn);

    const newSessBtn = document.createElement("button");
    newSessBtn.className = "bar-new-session-btn";
    newSessBtn.style.display = "flex";
    newSessBtn.tabIndex = -1;
    newSessBtn.setAttribute("aria-label", "New session");
    newSessBtn.innerHTML = '<i class="ph ph-plus"></i>';
    newSessBtn.addEventListener("click", () => showAddMenu(newSessBtn));
    container.appendChild(newSessBtn);

    const spacer = document.createElement("span");
    spacer.className = "bar-spacer";
    container.appendChild(spacer);

    if (isPhone()) {
      // Phone: utility buttons in toolbar (island has Esc/Tab/keyboard)
      const utils = [
        { icon: "terminal-window", label: "Terminal", click: onTerminalClick },
        { icon: "note-pencil", label: "Notes", click: onNotepadClick },
        { icon: "folder-open", label: "Files", click: onFilesClick },
        { icon: "plug", label: "Port Forward", click: onPortForwardClick, id: "bar-portfwd-btn", hidden: !portProxyEnabled },
        ...(options.pluginButtons || []).map(p => ({ icon: p.icon, label: p.label, click: p.click })),
        { icon: "gear", label: "Settings", click: onSettingsClick },
      ];
      for (const u of utils) {
        if (!u.click) continue;
        const btn = document.createElement("button");
        btn.className = "bar-icon-btn";
        btn.tabIndex = -1;
        btn.setAttribute("aria-label", u.label);
        btn.innerHTML = `<i class="ph ph-${u.icon}"></i>`;
        if (u.id) btn.id = u.id;
        if (u.hidden) btn.style.display = "none";
        btn.addEventListener("click", u.click);
        container.appendChild(btn);
      }
    } else {
      // Tablet: keep Esc/Tab/Keyboard in toolbar
      for (const s of pinnedKeys) {
        const btn = document.createElement("button");
        btn.className = "shortcut-btn";
        btn.tabIndex = -1;
        btn.textContent = s.label;
        btn.setAttribute("aria-label", `Send ${s.label}`);
        btn.addEventListener("click", () => {
          if (sendFn) {
            sendSequence(keysToSequence(s.keys), sendFn);
          }
          if (options.term) options.term.focus();
        });
        container.appendChild(btn);
      }

      const kbBtn = document.createElement("button");
      kbBtn.className = "bar-icon-btn";
      kbBtn.tabIndex = -1;
      kbBtn.setAttribute("aria-label", "Open shortcuts");
      kbBtn.innerHTML = '<i class="ph ph-keyboard"></i>';
      if (onShortcutsClick) {
        kbBtn.addEventListener("click", onShortcutsClick);
      }
      container.appendChild(kbBtn);
    }
  }

  function render(sessionName) {
    if (!container) return;
    currentSessionName = sessionName;

    // Abort any in-flight drag before wiping the DOM (cleans up overlay, ghost, refs)
    cleanupDrag();

    container.innerHTML = "";
    document.getElementById("key-island")?.remove();

    const connDot = document.createElement("span");
    connDot.id = "connection-indicator";
    connDot.style.display = "none";
    container.appendChild(connDot);

    if (isDesktop() && sessionStore) {
      const storeState = sessionStore.getState();
      const allSessions = storeState.sessions || [];

      // Filter to this window's tab set, preserving tab set order
      let sessions;
      if (windowTabSet) {
        const tabNames = windowTabSet.getTabs();
        const sessionMap = new Map(allSessions.map(s => [s.name, s]));
        // Use placeholder for tabs not yet in the store (e.g. just-created sessions)
        sessions = tabNames.map(n => sessionMap.get(n) || { name: n }).filter(Boolean);
      } else {
        sessions = allSessions;
      }

      renderDesktopTabs(sessionName, sessions);
    } else {
      renderMobile(sessionName);
    }

    // Floating island (Esc/Tab/keyboard on touch, plus utility buttons on tablet/desktop)
    renderKeyIsland();

    if (updateConnectionIndicator) updateConnectionIndicator();
  }

  let _islandResizeHandler = null;

  /** Floating pill with Esc/Tab/keyboard for touch devices in desktop tab mode */
  function renderKeyIsland() {
    // Remove previous island and its resize listeners
    document.getElementById("key-island")?.remove();
    if (_islandResizeHandler) {
      window.removeEventListener("resize", _islandResizeHandler);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", _islandResizeHandler);
      }
      _islandResizeHandler = null;
    }

    const island = document.createElement("div");
    island.id = "key-island";

    // Pinned keys and keyboard shortcut button — touch only (desktop has real keyboard)
    if (isTouch()) {
      for (const s of pinnedKeys) {
        const btn = document.createElement("button");
        btn.className = "key-island-btn";
        btn.textContent = s.label;
        btn.setAttribute("aria-label", `Send ${s.label}`);
        btn.addEventListener("click", () => {
          if (sendFn) sendSequence(keysToSequence(s.keys), sendFn);
          if (options.term) options.term.focus();
        });
        island.appendChild(btn);
      }

      // Copy button — copies xterm selection to clipboard (iOS can't copy
      // canvas-based selection via the native context menu)
      {
        const copyBtn = document.createElement("button");
        copyBtn.className = "key-island-btn key-island-icon";
        copyBtn.setAttribute("aria-label", "Copy selection");
        copyBtn.innerHTML = '<i class="ph ph-copy"></i>';
        copyBtn.addEventListener("click", () => {
          const term = options.term;
          if (term && term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection()).then(() => {
              copyBtn.innerHTML = '<i class="ph ph-check"></i>';
              setTimeout(() => { copyBtn.innerHTML = '<i class="ph ph-copy"></i>'; }, 1000);
            }).catch(() => {});
          }
          if (term) term.focus();
        });
        island.appendChild(copyBtn);
      }

      if (onShortcutsClick) {
        const kbBtn = document.createElement("button");
        kbBtn.className = "key-island-btn key-island-icon";
        kbBtn.setAttribute("aria-label", "Open shortcuts");
        kbBtn.innerHTML = '<i class="ph ph-keyboard"></i>';
        kbBtn.addEventListener("click", onShortcutsClick);
        island.appendChild(kbBtn);
      }

      if (onDictationClick) {
        const btn = document.createElement("button");
        btn.className = "key-island-btn key-island-icon";
        btn.setAttribute("aria-label", "Text input");
        btn.innerHTML = '<i class="ph ph-chat-text"></i>';
        btn.addEventListener("click", onDictationClick);
        island.appendChild(btn);
      }
    }

    // Utility buttons — skip on phone (they're in the toolbar)
    if (!isPhone()) {
      if (onNotepadClick) {
        const btn = document.createElement("button");
        btn.className = "key-island-btn key-island-icon";
        btn.setAttribute("aria-label", "Notes");
        btn.innerHTML = '<i class="ph ph-note-pencil"></i>';
        btn.addEventListener("click", onNotepadClick);
        island.appendChild(btn);
      }

      if (onFilesClick) {
        const btn = document.createElement("button");
        btn.className = "key-island-btn key-island-icon";
        btn.setAttribute("aria-label", "Files");
        btn.innerHTML = '<i class="ph ph-folder-open"></i>';
        btn.addEventListener("click", onFilesClick);
        island.appendChild(btn);
      }

      if (onPortForwardClick) {
        const btn = document.createElement("button");
        btn.className = "key-island-btn key-island-icon";
        btn.id = "bar-portfwd-btn";
        btn.setAttribute("aria-label", "Port Forward");
        btn.innerHTML = '<i class="ph ph-plug"></i>';
        btn.addEventListener("click", onPortForwardClick);
        if (!portProxyEnabled) btn.style.display = "none";
        island.appendChild(btn);
      }

      // Plugin buttons
      for (const p of (options.pluginButtons || [])) {
        if (!p.click) continue;
        const btn = document.createElement("button");
        btn.className = "key-island-btn key-island-icon";
        btn.setAttribute("aria-label", p.label);
        btn.innerHTML = `<i class="ph ph-${p.icon}"></i>`;
        btn.addEventListener("click", p.click);
        island.appendChild(btn);
      }

      if (onSettingsClick) {
        const btn = document.createElement("button");
        btn.className = "key-island-btn key-island-icon";
        btn.setAttribute("aria-label", "Settings");
        btn.innerHTML = '<i class="ph ph-gear"></i>';
        btn.addEventListener("click", onSettingsClick);
        island.appendChild(btn);
      }

    }

    // Connection dot — shown on all devices
    const dot = document.createElement("span");
    dot.id = "island-connection-dot";
    dot.className = "island-connection-dot";
    island.appendChild(dot);

    // Clamp island position to stay within viewport (with 8px margin)
    function clampIsland() {
      const rect = island.getBoundingClientRect();
      if (rect.width === 0) return; // not visible yet
      const margin = 8;
      const vw = window.visualViewport?.width ?? window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      // If fully visible with margin, nothing to do
      if (rect.left >= margin && rect.top >= margin &&
          rect.right <= vw - margin && rect.bottom <= vh - margin) return;
      // Nudge into view
      const nx = Math.max(margin, Math.min(rect.left, vw - rect.width - margin));
      const ny = Math.max(margin, Math.min(rect.top, vh - rect.height - margin));
      island.style.left = nx + "px";
      island.style.top = ny + "px";
      island.style.bottom = "auto";
      island.style.right = "auto";
      localStorage.setItem("katulong-key-island-pos", JSON.stringify({ x: nx, y: ny }));
    }

    // Restore saved position (clamped to current viewport)
    const saved = localStorage.getItem("katulong-key-island-pos");
    if (saved) {
      try {
        const { x, y } = JSON.parse(saved);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          island.style.left = x + "px";
          island.style.top = y + "px";
          island.style.bottom = "auto";
        }
      } catch {}
    }

    // Clamp after layout (when dimensions are known) and on every resize
    _islandResizeHandler = clampIsland;
    requestAnimationFrame(() => clampIsland());
    window.addEventListener("resize", clampIsland);
    // Also observe the visual viewport (fires more reliably on iOS/iPad)
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", clampIsland);
    }

    // Drag to reposition (touch + mouse, with dead zone so clicks/taps still work)
    let dragState = null;

    function islandDragMove(cx, cy) {
      if (!dragState) return;
      if (!dragState.dragging) {
        const dx = cx - dragState.startX;
        const dy = cy - dragState.startY;
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        dragState.dragging = true;
      }
      const x = cx - dragState.offsetX;
      const y = cy - dragState.offsetY;
      const margin = 8;
      const maxX = (window.visualViewport?.width ?? window.innerWidth) - island.offsetWidth - margin;
      const maxY = (window.visualViewport?.height ?? window.innerHeight) - island.offsetHeight - margin;
      island.style.left = Math.max(margin, Math.min(x, maxX)) + "px";
      island.style.top = Math.max(margin, Math.min(y, maxY)) + "px";
      island.style.bottom = "auto";
      island.style.right = "auto";
    }

    function islandDragEnd() {
      if (dragState?.dragging) {
        localStorage.setItem("katulong-key-island-pos", JSON.stringify({
          x: parseInt(island.style.left),
          y: parseInt(island.style.top),
        }));
      }
      dragState = null;
    }

    // Touch drag (skip if tapping the connection dot or a button)
    island.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      if (e.target.closest("button")) return;
      const t = e.touches[0];
      const rect = island.getBoundingClientRect();
      dragState = { startX: t.clientX, startY: t.clientY, offsetX: t.clientX - rect.left, offsetY: t.clientY - rect.top, dragging: false };
    }, { passive: false });
    island.addEventListener("touchmove", (e) => {
      if (!dragState) return;
      const t = e.touches[0];
      islandDragMove(t.clientX, t.clientY);
      if (dragState?.dragging) { e.preventDefault(); e.stopPropagation(); }
    }, { passive: false });
    island.addEventListener("touchend", (e) => {
      if (dragState?.dragging) e.preventDefault();
      islandDragEnd();
    });

    // Mouse drag
    island.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return; // let button clicks through
      const rect = island.getBoundingClientRect();
      dragState = { startX: e.clientX, startY: e.clientY, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, dragging: false };
      const onMouseMove = (me) => {
        islandDragMove(me.clientX, me.clientY);
        if (dragState?.dragging) { me.preventDefault(); }
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        islandDragEnd();
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    document.body.appendChild(island);
  }

  if (sessionStore) {
    sessionStore.subscribe(() => {
      if (currentSessionName && isDesktop()) {
        render(currentSessionName);
      }
    });
  }

  if (windowTabSet) {
    windowTabSet.subscribe(() => {
      if (currentSessionName && isDesktop()) {
        render(currentSessionName);
      }
    });
  }

  return {
    render,
    setPortProxyEnabled(enabled) {
      portProxyEnabled = enabled;
      const btn = document.getElementById("bar-portfwd-btn");
      if (btn) btn.style.display = enabled ? "" : "none";
    }
  };
}
