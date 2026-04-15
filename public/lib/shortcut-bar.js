/**
 * Shortcut Bar chrome — mounts <tile-tab-bar> + key-island tool row.
 *
 * Tab rendering and all tab interactions (click / drag / rename /
 * context menu) live in <tile-tab-bar>, which subscribes to ui-store
 * directly. This module owns only the surrounding chrome: the + button
 * dropdown, the utility tool row, and a generic menu helper for host-
 * initiated popups (e.g., <tile-tab-bar>'s tab-context-menu events).
 */

import { invalidateSessions } from "/lib/stores.js";
import { api, invalidateSessionIdCache } from "/lib/api-client.js";
import { detectPlatform } from "/lib/platform.js";
import { renderKeyIsland } from "/lib/key-island.js";
import "/lib/tile-tab-bar.js"; // registers <tile-tab-bar> custom element

export function createShortcutBar(options = {}) {
  const {
    container,
    pinnedKeys = [
      { label: "Esc", keys: "esc" },
      { label: "Tab", keys: "tab" }
    ],
    onNewSessionClick,
    onCreateTile,
    tileTypes = [],
    onTabClick,
    onAdoptSession,
    onTerminalClick,
    onFilesClick,
    onPortForwardClick,
    onSettingsClick,
    onShortcutsClick,
    onDictationClick,
    onNotepadClick,
    sendFn,
    sessionStore,
    windowTabSet,
    uiStore,
  } = options;

  let portProxyEnabled = true;
  let activeMenu = null;
  let _menuAnchor = null;
  const platform = detectPlatform();

  // ── Menu plumbing ────────────────────────────────────────────────────

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
      if (left + menuRect.width > window.innerWidth - 8) {
        left = window.innerWidth - menuRect.width - 8;
      }
      menu.style.left = Math.max(8, left) + "px";
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
      if (sessionStore) {
        const focusedId = uiStore?.getState?.().focusedId ?? null;
        invalidateSessions(sessionStore, focusedId);
      }
    }).catch(err => {
      console.error("[Session] Delete failed:", err);
    });
  }

  // ── + button dropdown ────────────────────────────────────────────────

  async function showAddMenu(addBtn) {
    if (activeMenu) {
      closeMenu();
      return;
    }
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

    if (tileTypes.length > 0) {
      for (const tt of tileTypes) {
        items.push({
          icon: tt.icon || "plus",
          label: `New ${tt.name}`,
          action: () => { if (onCreateTile) onCreateTile(tt.type, tt); },
        });
      }
    } else {
      items.push({
        icon: "plus",
        label: "New session",
        action: () => { if (onNewSessionClick) onNewSessionClick(); },
      });
    }

    const closedManaged = managed.filter(s => !openTabs.has(s.name));
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
            api.delete(`/sessions/by-id/${encodeURIComponent(s.id)}`).then(() => {
              invalidateSessionIdCache(s.name);
              if (windowTabSet) windowTabSet.onSessionKilled(s.name);
              if (sessionStore) {
                const focusedId = uiStore?.getState?.().focusedId ?? null;
                invalidateSessions(sessionStore, focusedId);
              }
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

  // ── Render chrome ────────────────────────────────────────────────────

  function render() {
    if (!container) return;

    const savedInputRow = container.querySelector(".bar-input-row");
    if (savedInputRow) savedInputRow.remove();

    // Command-mode surface (vim-style chord menu) lives in the same
    // bar slot but is owned by app.js; preserve it across re-renders
    // so the mode doesn't drop when the bar redraws (e.g. on tab change).
    const savedCommandSurface = container.querySelector(".command-surface");
    if (savedCommandSurface) savedCommandSurface.remove();

    container.innerHTML = "";
    document.getElementById("key-island")?.remove();

    container.style.display = "";
    container.classList.remove("bar-desktop", "bar-ipad", "bar-phone");
    container.classList.add("bar-ipad");
    document.body.dataset.platform = platform;

    const tabBar = document.createElement("tile-tab-bar");
    tabBar.store = uiStore;
    container.appendChild(tabBar);

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
      onTerminalClick,
      onDictationClick,
      portProxyEnabled,
      pluginButtons: options.pluginButtons,
    });

    if (savedInputRow) {
      const toolRow = container.querySelector("#key-island");
      if (toolRow) {
        container.insertBefore(savedInputRow, toolRow);
      } else {
        container.appendChild(savedInputRow);
      }
    }

    if (savedCommandSurface) container.appendChild(savedCommandSurface);
  }

  // Inline rename from a keyboard shortcut: delegates into <tile-tab-bar>.
  function beginRename(sessionName) {
    const tabBarEl = container?.querySelector("tile-tab-bar");
    if (!tabBarEl) return;
    const tabEl = tabBarEl.querySelector(
      `.tab-bar-tab[data-session="${CSS.escape(sessionName)}"]`,
    );
    if (tabEl) tabBarEl.startRename(tabEl, sessionName);
  }

  return {
    render,
    showAddMenu,
    showMenuFromHost: showMenu,
    beginRename,
    setPortProxyEnabled(enabled) {
      portProxyEnabled = enabled;
      const btn = document.getElementById("bar-portfwd-btn");
      if (btn) btn.style.display = enabled ? "" : "none";
    }
  };
}
