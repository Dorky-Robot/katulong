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

import { invalidateSessions } from "/lib/stores.js";
import { api } from "/lib/api-client.js";
import { detectPlatform } from "/lib/platform.js";
import { renderKeyIsland } from "/lib/key-island.js";
import { renderDesktopTabs } from "/lib/shortcut-bar-desktop.js";
import { renderIPadBar } from "/lib/shortcut-bar-ipad.js";
import { renderPhoneBar } from "/lib/shortcut-bar-phone.js";

const DRAG_OUT_THRESHOLD = 60; // px below bar to trigger tear-off (desktop)
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
    onCreateTile,
    tileTypes = [],
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
    sendFn,
    updateConnectionIndicator,
    getInstanceIcon,
    getSessionIcon,
    sessionStore,
    windowTabSet,
    carousel,
  } = options;

  let currentSessionName = "";
  let portProxyEnabled = true;
  let activeMenu = null; // currently open context/dropdown menu

  // Platform is detected once — it doesn't change at runtime
  const platform = detectPlatform();

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
    _menuAnchor = null;
    document.removeEventListener("click", onDocClickCloseMenu, true);
  }

  function onDocClickCloseMenu(e) {
    if (activeMenu && !activeMenu.contains(e.target)) {
      // Don't close if clicking the anchor button — let the toggle in
      // showAddMenu handle it, otherwise capture phase closes the menu
      // before the button's bubble handler can detect it's open.
      if (_menuAnchor && _menuAnchor.contains(e.target)) return;
      closeMenu();
    }
  }

  let _menuAnchor = null; // Track which element opened the menu

  function showMenu(items, anchorEl) {
    closeMenu();
    _menuAnchor = anchorEl;
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
          // Run delete action first (may show confirm dialog).
          // Only animate removal if the action wasn't cancelled.
          const cancelled = item.deleteAction(row);
          if (cancelled === false) return;
          // Slide-out animation after confirmed delete
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

    // Position near anchor (after layout so measurements are valid)
    requestAnimationFrame(() => {
      const rect = anchorEl.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const vh = window.visualViewport?.height ?? window.innerHeight;
      let left = rect.left;
      // Keep menu within viewport horizontally
      if (left + menuRect.width > window.innerWidth - 8) {
        left = window.innerWidth - menuRect.width - 8;
      }
      menu.style.left = Math.max(8, left) + "px";
      // Open above if not enough space below, anchored at bottom
      // so the menu grows downward (items slide down, not push up)
      if (rect.bottom + 4 + menuRect.height > vh - 8) {
        menu.style.bottom = (vh - rect.top + 4) + "px";
        menu.style.top = "auto";
      } else {
        menu.style.top = rect.bottom + 4 + "px";
      }

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
    // No tabs left — show empty state with + button
    if (onAllTabsClosed) onAllTabsClosed();
    render(null);
  }

  /** Close tab: remove from this window's tab set only (session stays managed on server) */
  function closeTab(sessionName) {
    // Remove from carousel first (handles tile unmount + focus shift)
    if (carousel?.isActive()) {
      carousel.removeCard(sessionName);
    }
    if (windowTabSet) windowTabSet.removeTab(sessionName);
  }

  async function detachTab(sessionName) {
    try {
      await api.delete(`/sessions/${encodeURIComponent(sessionName)}?action=detach`);
    } catch (err) {
      console.error("[Tab] Detach failed:", err);
      return;
    }
    if (carousel?.isActive()) carousel.removeCard(sessionName);
    if (windowTabSet) windowTabSet.removeTab(sessionName);
  }

  async function killTab(sessionName) {
    if (!confirm(`Kill session "${sessionName}"?\n\nThis will terminate the tmux session and all its processes.`)) return;
    try {
      await api.delete(`/sessions/${encodeURIComponent(sessionName)}`);
    } catch (err) {
      console.error("[Tab] Kill failed:", err);
      return;
    }
    if (carousel?.isActive()) carousel.removeCard(sessionName);
    if (windowTabSet) windowTabSet.onSessionKilled(sessionName);
  }

  /**
   * Show right-click context menu on a tab
   */
  function showTabContextMenu(e, sessionName) {
    e.preventDefault();
    const tab = e.currentTarget;
    const items = [
      {
        icon: "pencil-simple",
        label: "Rename",
        action: () => startTabRename(tab, sessionName)
      },
      {
        icon: "eject",
        label: "Detach",
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
    // Toggle: if menu is already open, just close it
    if (activeMenu) {
      closeMenu();
      return;
    }
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

    const items = [];

    // Tile types — "New Terminal" replaces "New session"
    if (tileTypes.length > 0) {
      for (const tt of tileTypes) {
        items.push({
          icon: tt.icon || "plus",
          label: `New ${tt.name}`,
          action: () => { if (onCreateTile) onCreateTile(tt.type, tt); },
        });
      }
    } else {
      // Fallback: no tile types registered, show classic "New session"
      items.push({
        icon: "plus",
        label: "New session",
        action: () => { if (onNewSessionClick) onNewSessionClick(); },
      });
    }

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
            if (!confirm(`Kill session "${s.name}"?\n\nThis will terminate the tmux session and all its processes.`)) return false;
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
          if (!confirm(msg)) return false;
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

  // Track active touch to block synthesized mouse events entirely
  let touchActive = false;

  function onTabMouseDown(e, tab, name) {
    if (e.button !== 0 || e.target.closest(".tab-close")) return;
    // Block synthesized mouse events from touch — they have different
    // coordinates and cause ghost jitter during drag.
    if (touchActive || drag) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const onMove = (me) => {
      if (drag?.isTouch) return; // touch owns the gesture
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

      if (drag?.isTouch) return; // touch owns the gesture

      if (!started) {
        if (name !== currentSessionName) {
          if (onTabClick) onTabClick(name);
        }
        return;
      }

      endDrag();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Double-tap tracking for tab rename (touch devices)
  let lastTapTab = null;
  let lastTapTime = 0;
  const DOUBLE_TAP_MS = 300;

  function onTabTouchStart(e, tab, name) {
    if (e.target.closest(".tab-close")) return;

    const initialTouch = e.touches[0];
    const startX = initialTouch.clientX;
    const startY = initialTouch.clientY;

    {
      // Touch: drag on horizontal movement, long press for context menu.
      // preventDefault on touchstart blocks synthesized mouse events and
      // native scroll — both of which cause jitter during drag.
      e.preventDefault();
      touchActive = true;
      let started = false;
      let longPressed = false;

      const longPressTimer = setTimeout(() => {
        longPressed = true;
        tab.classList.add("tab-long-press");
      }, LONG_PRESS_MS);

      const onMove = (te) => {
        const t = te.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (!longPressed && (Math.abs(dx) > DRAG_DEAD_ZONE || Math.abs(dy) > DRAG_DEAD_ZONE)) {
          clearTimeout(longPressTimer);
        }
        if (!started) {
          if (Math.abs(dx) < DRAG_DEAD_ZONE) return;
          started = true;
          clearTimeout(longPressTimer);
          beginDrag(tab, name, startX, true);
        }
        te.preventDefault();
        updateDrag(t.clientX, t.clientY);
      };

      const onEnd = () => {
        clearTimeout(longPressTimer);
        setTimeout(() => { touchActive = false; }, 50);
        tab.classList.remove("tab-long-press");
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
        document.removeEventListener("touchcancel", onEnd);
        if (started) {
          endDrag();
        } else if (longPressed) {
          showTabContextMenu({ preventDefault() {}, currentTarget: tab }, name);
        } else {
          // Tap without drag — check for double-tap to rename
          const now = Date.now();
          if (lastTapTab === tab && now - lastTapTime < DOUBLE_TAP_MS) {
            lastTapTab = null;
            lastTapTime = 0;
            startTabRename(tab, name);
          } else {
            lastTapTab = tab;
            lastTapTime = now;
            if (name !== currentSessionName && onTabClick) onTabClick(name);
          }
        }
      };

      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
      document.addEventListener("touchcancel", onEnd);
    }
  }

  function beginDrag(tab, name, startX, fromTouch) {
    if (drag) return; // already dragging (e.g. synthesized mouse from touch)
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
    // Position ghost at the tab's current location BEFORE appending to prevent
    // a flash at (0,0) on the first frame.
    const tabRect = rects[dragIndex];
    const tabTop = tab.getBoundingClientRect().top;
    ghost.style.transform = `translate3d(${tabRect.left}px, ${tabTop}px, 0)`;
    document.body.appendChild(ghost);

    tab.classList.add("tab-dragging");

    tabs.forEach((t, i) => {
      if (i !== dragIndex) t.style.transition = "transform 0.2s ease";
    });

    const grabOffset = startX - rects[dragIndex].left;

    // Cache ghost height and bar rect to avoid forced layout reflows every frame
    const ghostHeight = ghost.offsetHeight;
    const barRectCached = container.getBoundingClientRect();
    drag = {
      tab, name, ghost, tabs, rects, dragIndex,
      currentIndex: dragIndex,
      grabOffset,
      ghostHeight,
      barBottom: barRectCached.bottom,
      barLeft: barRectCached.left,
      barWidth: barRectCached.width,
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

    // Tear-off only for mouse (not touch — touch can't open new windows; Safari blocks popups)
    if (!drag.isTouch && cy > drag.barBottom + DRAG_OUT_THRESHOLD) {
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

    // Only update sibling transforms when the index actually changes —
    // re-setting the same transform on every frame causes needless work.
    if (newIndex !== drag.currentIndex) {
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
  }

  function getGap() {
    const area = container.querySelector(".tab-scroll-area") || container;
    return parseFloat(getComputedStyle(area).gap) || 0;
  }

  /** Clean up all drag state: ghost, stale refs */
  function cleanupDrag() {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    if (drag.tab) drag.tab.classList.remove("tab-dragging");
    if (drag.tabs) drag.tabs.forEach(t => { t.style.transition = ""; t.style.transform = ""; });
    drag = null;
  }

  function endDrag() {
    if (!drag) return;
    const { name, tabs: dragTabs, dragIndex, currentIndex, tornOff } = drag;

    cleanupDrag();

    if (tornOff) {
      openInNewWindow(name);
      closeTab(name);
    } else if (currentIndex !== dragIndex) {
      const names = dragTabs.map(t => t.dataset.session);
      const [moved] = names.splice(dragIndex, 1);
      names.splice(currentIndex, 0, moved);
      if (windowTabSet) {
        windowTabSet.reorderTabs(names);
      }
    }

    // drag is null now — flush any deferred render
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
    nameSpan.dataset.fullName = s.name;
    tab.appendChild(nameSpan);

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

  function _renderDesktopTabs(sessionName, sessions) {
    renderDesktopTabs({ container, sessionName, sessions, createTabEl, showAddMenu });
  }

  function _renderPhoneBar(sessionName) {
    renderPhoneBar({
      container,
      sessionName,
      sessionIcon: iconForSession(sessionName),
      onSessionClick,
      showAddMenu,
      onTerminalClick,
      onNotepadClick,
      onFilesClick,
      onPortForwardClick,
      onSettingsClick,
      portProxyEnabled,
      pluginButtons: options.pluginButtons,
    });
  }

  /** Build the session list from stores (shared by desktop + iPad paths) */
  function getSessionList() {
    if (!sessionStore) return [];
    const allSessions = sessionStore.getState().sessions || [];
    if (!windowTabSet) return allSessions;
    const tabNames = windowTabSet.getTabs();
    const sessionMap = new Map(allSessions.map(s => [s.name, s]));
    return tabNames.map(n => sessionMap.get(n) || { name: n }).filter(Boolean);
  }

  function _renderIPadBar(sessionName, sessions) {
    renderIPadBar({ container, sessionName, sessions, createTabEl, showAddMenu });
  }

  /**
   * Adaptive tab label truncation with middle-ellipsis.
   *
   * Progression as tabs get narrower:
   *   [icon] name-of-session  →  name-of-session  →  name...sion  →  na...on  →  n…
   *
   * Measures available space per tab and truncates labels to fit,
   * keeping both the start and end of the name visible.
   */
  function fitTabLabels() {
    const tabArea = container.querySelector(".tab-scroll-area");
    if (!tabArea) return;
    const tabs = [...tabArea.querySelectorAll(".tab-bar-tab")];
    if (tabs.length === 0) return;

    const areaWidth = tabArea.clientWidth;
    const gap = parseFloat(getComputedStyle(tabArea).gap) || 0;
    const totalGap = gap * (tabs.length - 1);
    const availPerTab = Math.floor((areaWidth - totalGap) / tabs.length);

    for (const tab of tabs) {
      const label = tab.querySelector(".tab-label");
      const icon = tab.querySelector("i.ph");
      if (!label) continue;

      const fullName = label.dataset.fullName || label.textContent;
      const padLeft = parseFloat(getComputedStyle(tab).paddingLeft) || 0;
      const padRight = parseFloat(getComputedStyle(tab).paddingRight) || 0;
      const iconWidth = icon ? (icon.offsetWidth + 6) : 0; // 6px = gap
      const chrome = padLeft + padRight;

      // Measure text width using canvas (no reflow)
      const font = getComputedStyle(label).font;
      const measure = (text) => {
        const c = document.createElement("canvas").getContext("2d");
        c.font = font;
        return c.measureText(text).width;
      };

      const fullWidth = measure(fullName);
      const spaceWithIcon = availPerTab - chrome - iconWidth;
      const spaceNoIcon = availPerTab - chrome;

      // Phase 1: full name with icon
      if (fullWidth <= spaceWithIcon) {
        if (icon) icon.style.display = "";
        label.textContent = fullName;
        continue;
      }

      // Phase 2: full name, no icon
      if (icon) icon.style.display = "none";
      if (fullWidth <= spaceNoIcon) {
        label.textContent = fullName;
        continue;
      }

      // Phase 3: middle-ellipsis — keep start and end visible
      const ellipsis = "…";
      const ellipsisW = measure(ellipsis);
      const budget = spaceNoIcon - ellipsisW;

      if (budget <= measure(fullName[0])) {
        // Phase 5: just first letter
        label.textContent = fullName[0];
        continue;
      }

      // Split budget 60/40 between start and end
      const startBudget = budget * 0.6;
      const endBudget = budget * 0.4;

      let startLen = 0;
      let startW = 0;
      for (let i = 0; i < fullName.length; i++) {
        const w = measure(fullName[i]);
        if (startW + w > startBudget) break;
        startW += w;
        startLen = i + 1;
      }

      let endLen = 0;
      let endW = 0;
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
        label.textContent = fullName[0];
      }
    }
  }

  // Re-fit tabs when the window resizes
  window.addEventListener("resize", () => {
    if (container.querySelector(".tab-scroll-area")) fitTabLabels();
  });

  // ── Render gate ────────────────────────────────────────────────────
  // All renders flow through this gate. During drag, renders are
  // deferred (not lost) and replayed when drag ends.

  let needsRender = false;

  function requestRender(sessionName) {
    currentSessionName = sessionName;
    if (drag) { needsRender = true; return; }
    render(sessionName);
  }

  function render(sessionName) {
    if (!container) return;
    currentSessionName = sessionName;
    needsRender = false;

    cleanupDrag();

    const savedInputRow = container.querySelector(".bar-input-row");
    if (savedInputRow) savedInputRow.remove();

    container.innerHTML = "";
    document.getElementById("key-island")?.remove();

    // Connection indicator (hidden by default, shown by updateConnectionIndicator)
    const connDot = document.createElement("span");
    connDot.id = "connection-indicator";
    connDot.style.display = "none";
    container.appendChild(connDot);

    container.style.display = "";

    // Platform class — set once, never changes (platform is const)
    container.classList.remove("bar-desktop", "bar-ipad", "bar-phone");
    container.classList.add("bar-ipad");
    document.body.dataset.platform = platform;

    // Unified tab bar — all platforms use the same renderer
    // with the card carousel layout.
    const sessions = getSessionList();
    _renderIPadBar(sessionName, sessions);

    // Adaptive tab truncation — fit tabs to available width
    requestAnimationFrame(() => fitTabLabels());

    // Tool row — pinned keys + utility buttons, docked inside the bar
    renderKeyIsland({
      parentEl: container,
      platform,
      pinnedKeys,
      sendFn,
      getTerm: () => options.term,
      terminalPool: options.terminalPool,
      onShortcutsClick,
      onNotepadClick,
      onFilesClick,
      onPortForwardClick,
      onSettingsClick,
      portProxyEnabled,
      pluginButtons: options.pluginButtons,
    });

    // Re-insert preserved inline input row
    if (savedInputRow) {
      const toolRow = container.querySelector("#key-island");
      if (toolRow) {
        container.insertBefore(savedInputRow, toolRow);
      } else {
        container.appendChild(savedInputRow);
      }
    }

    if (updateConnectionIndicator) updateConnectionIndicator();
  }

  // Store subscribers — coalesce rapid updates into a single render via rAF.
  // requestRender() handles the drag-deferral check.
  let _rafId = null;
  function onStoreChange() {
    if (!currentSessionName) return;
    if (_rafId) return;
    _rafId = requestAnimationFrame(() => {
      _rafId = null;
      requestRender(currentSessionName);
    });
  }

  if (sessionStore) sessionStore.subscribe(onStoreChange);
  if (windowTabSet) windowTabSet.subscribe(onStoreChange);

  /**
   * Lightweight active-tab update — just toggles the .active class
   * without rebuilding the entire bar. Use this for carousel card switches.
   */
  function setActiveTab(sessionName) {
    currentSessionName = sessionName;
    const tabs = container.querySelectorAll(".tab-bar-tab");
    for (const tab of tabs) {
      tab.classList.toggle("active", tab.dataset.session === sessionName);
    }
  }

  return {
    render: requestRender,
    setActiveTab,
    showAddMenu,
    setPortProxyEnabled(enabled) {
      portProxyEnabled = enabled;
      const btn = document.getElementById("bar-portfwd-btn");
      if (btn) btn.style.display = enabled ? "" : "none";
    }
  };
}
