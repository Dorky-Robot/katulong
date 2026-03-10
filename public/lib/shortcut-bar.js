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
const DRAG_OUT_THRESHOLD = 60; // px below bar to trigger tear-off
const DRAG_DEAD_ZONE = 5; // px before drag starts

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
    onAdoptSession,
    onFilesClick,
    onPortForwardClick,
    onSettingsClick,
    onShortcutsClick,
    sendFn,
    updateP2PIndicator,
    getInstanceIcon,
    sessionStore,
    windowTabSet
  } = options;

  let currentSessionName = "";
  let portProxyEnabled = true;
  let activeMenu = null; // currently open context/dropdown menu

  function isDesktop() {
    return window.matchMedia(DESKTOP_MQ).matches || window.matchMedia(TABLET_MQ).matches;
  }

  function isTouch() {
    return window.matchMedia("(pointer: coarse)").matches;
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
    window.open(url, "_blank", "width=900,height=600");
    if (savedTabs) sessionStorage.setItem("katulong-window-tabs", savedTabs);
    if (savedWindowId) sessionStorage.setItem("katulong-window-id", savedWindowId);
  }

  // ── Tab actions ────────────────────────────────────────────────────

  /** After removing a tab, navigate to the nearest remaining tab or "/" */
  function navigateAfterRemoval(removedName, priorIndex) {
    const remaining = windowTabSet ? windowTabSet.getTabs() : [];
    if (removedName !== currentSessionName) { render(currentSessionName); return; }
    if (remaining.length === 0) { location.href = "/"; return; }
    const idx = typeof priorIndex === "number" ? priorIndex : 0;
    if (onTabClick) onTabClick(remaining[Math.min(idx, remaining.length - 1)]);
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
   * Show + button dropdown: new session + unmanaged tmux sessions
   */
  async function showAddMenu(addBtn) {
    // Fetch fresh unmanaged tmux sessions with attached status
    let unmanaged = [];
    try {
      const data = await api.get(`/tmux-sessions?_t=${Date.now()}`);
      unmanaged = (data || []).map(s => typeof s === "string" ? { name: s, attached: false } : s);
    } catch (err) { console.error("[showAddMenu] fetch error:", err); }

    const items = [
      {
        icon: "plus",
        label: "New session",
        action: () => { if (onNewSessionClick) onNewSessionClick(); }
      }
    ];

    // Unmanaged tmux sessions
    if (unmanaged.length > 0) {
      items.push({ divider: true, label: "Detached tmux sessions" });
      for (const s of unmanaged) {
        const item = {
          icon: s.attached ? "link" : "plug",
          label: s.name + (s.attached ? " (attached)" : ""),
          action: () => {
            if (onAdoptSession) onAdoptSession(s.name);
          },
        };
        // Only allow delete on sessions with no external clients attached
        if (!s.attached) {
          item.deleteAction = () => deleteUnmanagedSession(s.name);
        }
        items.push(item);
      }
    }

    showMenu(items, addBtn);
  }

  // ── Chrome-style drag reorder ──────────────────────────────────────

  let drag = null;

  function onTabMouseDown(e, tab, name) {
    if (e.button !== 0 || e.target.closest(".tab-close")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const onMove = (me) => {
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
        if (name !== currentSessionName && onTabClick) onTabClick(name);
        return;
      }

      endDrag();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function onTabTouchStart(e, tab, name) {
    if (e.target.closest(".tab-close")) return;

    // Claim the touch immediately so Safari doesn't start page scrolling.
    // Taps still work — we fire onTabClick in onEnd if there was no movement.
    e.preventDefault();

    const touch = e.touches[0];
    const startX = touch.clientX;
    const startY = touch.clientY;
    let started = false;

    const onMove = (te) => {
      const t = te.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (!started) {
        if (Math.abs(dx) < DRAG_DEAD_ZONE && Math.abs(dy) < DRAG_DEAD_ZONE) return;
        started = true;
        beginDrag(tab, name, startX, true);
      }

      te.preventDefault();
      updateDrag(t.clientX, t.clientY);
    };

    const onEnd = () => {
      cleanup();

      if (!started) {
        if (name !== currentSessionName && onTabClick) onTabClick(name);
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

    const rects = tabs.map(t => {
      const r = t.getBoundingClientRect();
      return { left: r.left, width: r.width, center: r.left + r.width / 2 };
    });

    const ghost = tab.cloneNode(true);
    ghost.classList.add("tab-drag-ghost");
    ghost.style.width = rects[dragIndex].width + "px";
    ghost.style.height = tab.offsetHeight + "px";
    document.body.appendChild(ghost);

    tab.classList.add("tab-dragging");

    tabs.forEach((t, i) => {
      if (i !== dragIndex) t.style.transition = "transform 0.2s ease";
    });

    const grabOffset = startX - rects[dragIndex].left;

    drag = {
      tab, name, ghost, tabs, rects, dragIndex,
      currentIndex: dragIndex,
      grabOffset,
      tornOff: false,
      isTouch: !!fromTouch,
    };
  }

  function updateDrag(cx, cy) {
    if (!drag) return;
    const { ghost, tabs, rects, dragIndex, grabOffset } = drag;

    ghost.style.left = (cx - grabOffset) + "px";
    ghost.style.top = (cy - ghost.offsetHeight / 2) + "px";

    const barRect = container.getBoundingClientRect();
    // Tear-off only for mouse — touch can't open new windows (Safari blocks popups)
    if (!drag.isTouch && cy > barRect.bottom + DRAG_OUT_THRESHOLD) {
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
    return parseFloat(getComputedStyle(container).gap) || 0;
  }

  function endDrag() {
    if (!drag) return;
    const { tab, name, ghost, tabs, dragIndex, currentIndex, tornOff } = drag;

    ghost.remove();

    tabs.forEach(t => {
      t.style.transition = "";
      t.style.transform = "";
    });

    tab.classList.remove("tab-dragging");

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

  function renderDesktopTabs(sessionName, sessions) {

    // Session tabs
    for (const s of sessions) {
      const tab = document.createElement("button");
      tab.className = "tab-bar-tab" + (s.name === sessionName ? " active" : "");
      tab.tabIndex = -1;
      tab.dataset.session = s.name;
      tab.setAttribute("aria-label", `Session: ${s.name}`);

      const rawIcon = getInstanceIcon ? getInstanceIcon() : "terminal-window";
      const instanceIcon = rawIcon.replace(/[^a-z0-9-]/g, "");
      const iconEl = document.createElement("i");
      iconEl.className = `ph ph-${instanceIcon}`;
      tab.appendChild(iconEl);

      const nameSpan = document.createElement("span");
      nameSpan.className = "tab-label";
      nameSpan.textContent = s.name;
      tab.appendChild(nameSpan);

      // Close button (×) — click to detach (like closing a Chrome tab)
      const closeBtn = document.createElement("span");
      closeBtn.className = "tab-close";
      closeBtn.setAttribute("aria-label", `Close ${s.name}`);
      closeBtn.innerHTML = '<i class="ph ph-x"></i>';
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(s.name);
      });
      tab.appendChild(closeBtn);

      // Right-click context menu
      tab.addEventListener("contextmenu", (e) => showTabContextMenu(e, s.name));

      // Drag-reorder / click-to-switch
      tab.addEventListener("mousedown", (e) => onTabMouseDown(e, tab, s.name));
      tab.addEventListener("touchstart", (e) => onTabTouchStart(e, tab, s.name), { passive: false });

      container.appendChild(tab);
    }

    // New session + button (dropdown if unmanaged sessions exist)
    const addBtn = document.createElement("button");
    addBtn.className = "tab-bar-add";
    addBtn.tabIndex = -1;
    addBtn.setAttribute("aria-label", "New session");
    addBtn.innerHTML = '<i class="ph ph-plus-circle"></i>';
    addBtn.addEventListener("click", () => showAddMenu(addBtn));
    container.appendChild(addBtn);

    // Spacer
    const spacer = document.createElement("span");
    spacer.className = "bar-spacer";
    container.appendChild(spacer);

    // Utility buttons: Files
    if (onFilesClick) {
      const filesBtn = document.createElement("button");
      filesBtn.className = "bar-utility-btn";
      filesBtn.tabIndex = -1;
      filesBtn.setAttribute("aria-label", "Files");
      filesBtn.title = "Files";
      filesBtn.innerHTML = '<i class="ph ph-folder-open"></i>';
      filesBtn.addEventListener("click", onFilesClick);
      container.appendChild(filesBtn);
    }

    // Utility buttons: Port Forward
    if (onPortForwardClick) {
      const pfBtn = document.createElement("button");
      pfBtn.className = "bar-utility-btn";
      pfBtn.id = "bar-portfwd-btn";
      pfBtn.tabIndex = -1;
      pfBtn.setAttribute("aria-label", "Port Forward");
      pfBtn.title = "Port Forward";
      pfBtn.innerHTML = '<i class="ph ph-plug"></i>';
      pfBtn.addEventListener("click", onPortForwardClick);
      if (!portProxyEnabled) pfBtn.style.display = "none";
      container.appendChild(pfBtn);
    }

    // Utility buttons: Settings
    if (onSettingsClick) {
      const settingsBtn = document.createElement("button");
      settingsBtn.className = "bar-utility-btn";
      settingsBtn.tabIndex = -1;
      settingsBtn.setAttribute("aria-label", "Settings");
      settingsBtn.title = "Settings";
      settingsBtn.innerHTML = '<i class="ph ph-gear"></i>';
      settingsBtn.addEventListener("click", onSettingsClick);
      container.appendChild(settingsBtn);
    }

    // P2P dot
    const p2pDot = document.createElement("span");
    p2pDot.className = "bar-p2p-dot";
    p2pDot.id = "bar-p2p-dot";
    container.appendChild(p2pDot);
  }

  function renderMobile(sessionName) {
    const sessBtn = document.createElement("button");
    sessBtn.className = "session-btn";
    sessBtn.tabIndex = -1;
    sessBtn.setAttribute("aria-label", `Session: ${sessionName}`);
    const rawIcon = getInstanceIcon ? getInstanceIcon() : "terminal-window";
    const instanceIcon = rawIcon.replace(/[^a-z0-9-]/g, "");
    const iconEl = document.createElement("i");
    iconEl.className = `ph ph-${instanceIcon}`;
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
    if (onNewSessionClick) {
      newSessBtn.addEventListener("click", onNewSessionClick);
    }
    container.appendChild(newSessBtn);

    const spacer = document.createElement("span");
    spacer.className = "bar-spacer";
    container.appendChild(spacer);

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

  function render(sessionName) {
    if (!container) return;
    currentSessionName = sessionName;

    container.innerHTML = "";
    document.getElementById("key-island")?.remove();

    const p2pDot = document.createElement("span");
    p2pDot.id = "p2p-indicator";
    p2pDot.style.display = "none";
    container.appendChild(p2pDot);

    if (updateP2PIndicator) updateP2PIndicator();

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

      // Floating key island for touch devices showing desktop tabs (iPad)
      if (isTouch()) renderKeyIsland();
    } else {
      renderMobile(sessionName);
    }
  }

  /** Floating pill with Esc/Tab/keyboard for touch devices in desktop tab mode */
  function renderKeyIsland() {
    // Remove previous island if any
    document.getElementById("key-island")?.remove();

    const island = document.createElement("div");
    island.id = "key-island";

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

    if (onShortcutsClick) {
      const kbBtn = document.createElement("button");
      kbBtn.className = "key-island-btn key-island-icon";
      kbBtn.setAttribute("aria-label", "Open shortcuts");
      kbBtn.innerHTML = '<i class="ph ph-keyboard"></i>';
      kbBtn.addEventListener("click", onShortcutsClick);
      island.appendChild(kbBtn);
    }

    // Restore saved position
    const saved = localStorage.getItem("katulong-key-island-pos");
    if (saved) {
      try {
        const { x, y } = JSON.parse(saved);
        island.style.left = x + "px";
        island.style.top = y + "px";
        island.style.bottom = "auto";
      } catch {}
    }

    // Touch drag to reposition (with dead zone so taps still work)
    let dragState = null;
    island.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const rect = island.getBoundingClientRect();
      dragState = {
        startX: t.clientX,
        startY: t.clientY,
        offsetX: t.clientX - rect.left,
        offsetY: t.clientY - rect.top,
        dragging: false,
      };
    }, { passive: false });

    island.addEventListener("touchmove", (e) => {
      if (!dragState) return;
      const t = e.touches[0];

      if (!dragState.dragging) {
        const dx = t.clientX - dragState.startX;
        const dy = t.clientY - dragState.startY;
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        dragState.dragging = true;
      }

      e.preventDefault();
      e.stopPropagation();
      const x = t.clientX - dragState.offsetX;
      const y = t.clientY - dragState.offsetY;
      const maxX = window.innerWidth - island.offsetWidth;
      const maxY = window.innerHeight - island.offsetHeight;
      island.style.left = Math.max(0, Math.min(x, maxX)) + "px";
      island.style.top = Math.max(0, Math.min(y, maxY)) + "px";
      island.style.bottom = "auto";
      island.style.right = "auto";
    }, { passive: false });

    island.addEventListener("touchend", (e) => {
      if (dragState?.dragging) {
        // Suppress the click that would follow
        e.preventDefault();
        localStorage.setItem("katulong-key-island-pos", JSON.stringify({
          x: parseInt(island.style.left),
          y: parseInt(island.style.top),
        }));
      }
      dragState = null;
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
