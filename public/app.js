    import { ModalRegistry } from "/lib/modal.js";
    import { createTerminalPool } from "/lib/terminal-pool.js";
    import {
      createSessionStore, invalidateSessions,
      createTokenStore, setNewToken, invalidateTokens, removeToken, loadTokens as reloadTokens,
      createShortcutsStore, loadShortcuts as reloadShortcuts,
    } from "/lib/stores.js";
    import { createSessionListComponent, updateSnapshot } from "/lib/session-list-component.js";
    import { api } from "/lib/api-client.js";
    import { createTokenListComponent } from "/lib/token-list-component.js";
    import { createTokenFormManager } from "/lib/token-form.js";
    import { createShortcutsPopup, createShortcutsEditPanel, createAddShortcutModal } from "/lib/shortcuts-components.js";
    import { createDictationModal } from "/lib/dictation-modal.js";
    import { createDragDropManager } from "/lib/drag-drop.js";
    import { showToast, isImageFile, uploadImageToTerminal as uploadImageToTerminalFn, uploadImagesToTerminal as uploadImagesToTerminalFn, onPasteComplete } from "/lib/image-upload.js";
    import { createJoystickManager } from "/lib/joystick.js";
    import { attachTouchSelect } from "/lib/touch-select.js";

    import { createThemeManager, DARK_THEME, LIGHT_THEME } from "/lib/theme-manager.js";
    import { createTabManager } from "/lib/tab-manager.js";
    import { isAtBottom, scrollToBottom, withPreservedScroll, terminalWriteWithScroll, initScrollTracking, initTouchScroll } from "/lib/scroll-utils.js";
    import { keysToSequence, sendSequence, displayKey, keysLabel, keysString, VALID_KEYS, normalizeKey } from "/lib/key-mapping.js";
    import { createShortcutBar } from "/lib/shortcut-bar.js";
    import { createWindowTabSet } from "/lib/window-tab-set.js";
    import { createPasteHandler } from "/lib/paste-handler.js";
    import { createNetworkMonitor } from "/lib/network-monitor.js";
    import { createSettingsHandlers } from "/lib/settings-handlers.js";
    import { createTerminalKeyboard } from "/lib/terminal-keyboard.js";
    import { createInputSender } from "/lib/input-sender.js";
    import { createViewportManager } from "/lib/viewport-manager.js";
    import { createHelmComponent } from "/lib/helm/helm-component.js";
    import { createWebSocketConnection } from "/lib/websocket-connection.js";
    import { createFileBrowserStore, loadRoot } from "/lib/file-browser/file-browser-store.js";
    import { createFileBrowserComponent } from "/lib/file-browser/file-browser-component.js";
    import { createPortForwardComponent } from "/lib/port-forward/port-forward-component.js";
    import { createNotepad } from "/lib/notepad.js";
    import { createSplitManager } from "/lib/split-manager.js";

    // --- Modal Manager ---
    const modals = new ModalRegistry();

    // Modal registration imported from /lib/modal-init.js

    // --- Theme (using composable theme manager) ---
    const themeManager = createThemeManager({
      onThemeChange: (themeData) => {
        terminalPool.forEach((name, entry) => {
          withPreservedScroll(entry.term, () => {
            entry.term.options.theme = themeData;
          });
        });
      }
    });

    const applyTheme = themeManager.apply;

    // --- State ---

    // --- Centralized application state (at edge) ---
    const explicitSession = new URLSearchParams(location.search).get("s");
    const createAppState = () => {
      const initialSessionName = explicitSession || null;

      return {
        session: {
          name: initialSessionName,
          shortcuts: []
        },
        connection: {
          ws: null,
          attached: false,
          reconnectDelay: 1000
        },
        scroll: {
          userScrolledUpBeforeDisconnect: false
        },
        // Controlled state updates
        update(path, value) {
          const keys = path.split('.');
          let obj = this;
          for (let i = 0; i < keys.length - 1; i++) {
            obj = obj[keys[i]];
          }
          obj[keys[keys.length - 1]] = value;
          return this;
        },
        // Batch updates
        updateMany(updates) {
          Object.entries(updates).forEach(([path, value]) => {
            this.update(path, value);
          });
          return this;
        }
      };
    };

    const state = createAppState();

    // --- Instance Icon ---
    let instanceIcon = "terminal-window";
    let shortcutBarInstance = null;
    const getInstanceIcon = () => instanceIcon;

    // --- Per-session tab icon overrides ---
    // sessionName -> Phosphor icon name (set via OSC 7337 from terminal processes)
    const sessionIcons = new Map();
    const getSessionIcon = (name) => sessionIcons.get(name) || null;
    const setInstanceIcon = (icon) => {
      instanceIcon = icon.replace(/[^a-z0-9-]/g, "");
      // Re-render shortcut bar to show new icon
      if (shortcutBarInstance) {
        shortcutBarInstance.render(state.session.name);
      }
    };

    // --- Shortcuts state management (reactive store) ---
    const shortcutsStore = createShortcutsStore();
    const loadShortcuts = () => reloadShortcuts(shortcutsStore);

    // Subscribe to shortcuts changes for render side effects
    // Note: shortcuts store subscription moved after renderBar is defined (line ~640)

    // --- Connection Indicator ---

    const updateConnectionIndicator = () => {
      const attached = state.connection.attached;
      const title = attached ? "Connected" : "Disconnected";
      for (const id of ["sidebar-connection-dot", "connection-indicator", "island-connection-dot"]) {
        const dot = document.getElementById(id);
        if (!dot) continue;
        dot.classList.toggle("connected", attached);
        dot.title = title;
      }
    };

    if (state.session.name) document.title = state.session.name;

    // --- Terminal pool ---
    // One xterm.js Terminal per managed session, visibility-toggled on switch.

    const terminalPool = createTerminalPool({
      parentEl: document.getElementById("terminal-container"),
      terminalOptions: {
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
        theme: themeManager.getEffective() === "light" ? LIGHT_THEME : DARK_THEME,
        cursorBlink: true,
        scrollback: 10000,
        convertEol: true,
        macOptionIsMeta: true,
        minimumContrastRatio: 4.5,
        cursorInactiveStyle: 'outline',
        rightClickSelectsWord: true,
        rescaleOverlappingGlyphs: true,
      },
      onTerminalCreated: (sessionName, entry) => {
        // Wire up keyboard handler for each new terminal
        // Uses late-bound rawSend — safe because onTerminalCreated is only
        // called from activate() which first runs after rawSend is defined.
        const kb = createTerminalKeyboard({
          term: entry.term,
          onSend: (data) => rawSend(data),
          onToggleSearch: toggleSearchBar
        });
        kb.init();

        // On touch devices (iPad/phone), xterm.js selection is canvas-based
        // so the native iOS "Copy" menu reads an empty DOM selection.  Fix by
        // writing selected text to the system clipboard automatically.
        // Also attach long-press-to-select so finger touch can select text
        // (xterm.js only handles mouse/trackpad selection natively).
        if (window.matchMedia("(pointer: coarse)").matches) {
          entry.term.onSelectionChange(() => {
            const text = entry.term.getSelection();
            if (text) {
              navigator.clipboard.writeText(text).catch(() => {});
            }
          });
          attachTouchSelect(entry.term);
        }

        // Track user-initiated scrolling so rapid output doesn't
        // fight the user's scroll position.
        initScrollTracking(entry.term);
        initTouchScroll(entry.term);

        // Attach scroll-to-bottom button to this terminal's viewport.
        // Deferred one frame so xterm.js has rendered the viewport element.
        requestAnimationFrame(() => _attachScrollButton());

        // OSC 7337 handler: per-session tab icon override
        // Terminal processes can emit: \033]7337;icon=cube\007
        // to change their tab's icon. Empty value resets to instance default.
        entry.term.parser.registerOscHandler(7337, (data) => {
          const match = data.match(/^icon=([a-z0-9-]*)$/);
          if (!match) return false; // not our OSC, let xterm handle it
          const iconName = match[1];
          const currentName = entry.sessionName;
          if (iconName) {
            sessionIcons.set(currentName, iconName);
          } else {
            sessionIcons.delete(currentName);
          }
          // Re-render tabs to show the new icon
          if (shortcutBarInstance) shortcutBarInstance.render(state.session.name);
          // Notify server so other clients see the change
          const ws = state.connection.ws;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "set-tab-icon", session: currentName, icon: iconName || null }));
          }
          return true; // handled
        });

        // Terminal preview snapshots (throttled per-terminal)
        // Read entry.sessionName dynamically so renames are reflected
        let lastSnapshotTime = 0;
        let timer = null;
        entry.term.onRender(() => {
          const now = Date.now();
          const elapsed = now - lastSnapshotTime;
          if (elapsed < 3000) {
            if (!timer) {
              timer = setTimeout(() => {
                timer = null;
                lastSnapshotTime = Date.now();
                updateSnapshot(entry.sessionName, entry.term);
              }, 3000 - elapsed);
            }
            return;
          }
          if (timer) { clearTimeout(timer); timer = null; }
          lastSnapshotTime = now;
          updateSnapshot(entry.sessionName, entry.term);
        });
      }
    });

    // Convenience accessors — always reference the active terminal
    const getTerm = () => terminalPool.getActive()?.term;
    const getFit = () => terminalPool.getActive()?.fit;
    const getSearchAddon = () => terminalPool.getActive()?.searchAddon;

    // --- Split Manager (iPad/tablet only) ---
    const splitManager = createSplitManager({
      terminalContainer: document.getElementById("terminal-container"),
      terminalPool,
      sendResize: (session, cols, rows) => {
        if (state.connection.ws?.readyState === 1) {
          state.connection.ws.send(JSON.stringify({ type: "resize", session, cols, rows }));
        }
      }
    });

    // When the user taps a split pane, update state.session.name for input routing
    splitManager.onFocusChange = (sessionName) => {
      if (sessionName !== state.session.name) {
        state.update('session.name', sessionName);
        document.title = sessionName;
        const url = new URL(window.location);
        url.searchParams.set("s", sessionName);
        history.replaceState(null, "", url);
        if (shortcutBarInstance) shortcutBarInstance.render(sessionName);
      }
    };

    // When split state changes, clean up protection and re-render
    splitManager.onSplitChanged = ({ isSplit, pane1, pane2 }) => {
      if (!isSplit) {
        // Unsplit: unprotect all, update state
        terminalPool.forEach((name) => terminalPool.unprotect(name));
        if (pane1) {
          state.update('session.name', pane1);
          document.title = pane1;
          const url = new URL(window.location);
          url.searchParams.set("s", pane1);
          history.replaceState(null, "", url);
        }
      }
      if (shortcutBarInstance) shortcutBarInstance.render(state.session.name);
      fitActiveTerminal();
    };

    /** Fit the active terminal after a visibility change (e.g. closing file browser/port forward) */
    function fitActiveTerminal() {
      requestAnimationFrame(() => {
        // In split mode, fit both panes
        if (splitManager.isSplit()) {
          splitManager.fitAll();
          return;
        }
        const active = terminalPool.getActive();
        if (!active) return;
        withPreservedScroll(active.term, () => active.fit.fit());
        // After fit, send updated dimensions to the server.
        // The ResizeObserver only fires when the container element changes size,
        // but fit() can change the terminal rows/cols without the container
        // changing (e.g. on initial attach when the container was already laid out).
        if (state.connection.ws?.readyState === 1) {
          state.connection.ws.send(JSON.stringify({ type: "resize", session: state.session.name, cols: active.term.cols, rows: active.term.rows }));
        }
      });
    }

    // --- Search bar ---
    const searchBar = document.getElementById("search-bar");
    const searchInput = document.getElementById("search-input");
    const searchClose = document.getElementById("search-close");

    function toggleSearchBar() {
      const visible = searchBar.classList.toggle("visible");
      if (visible) {
        searchInput.focus();
        searchInput.select();
      } else {
        searchInput.value = "";
        getSearchAddon()?.clearDecorations();
        getTerm()?.focus();
      }
    }

    searchInput.addEventListener("input", () => {
      if (searchInput.value) {
        getSearchAddon()?.findNext(searchInput.value);
      } else {
        getSearchAddon()?.clearDecorations();
      }
    });
    searchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        toggleSearchBar();
        ev.preventDefault();
      } else if (ev.key === "Enter") {
        if (ev.shiftKey) {
          getSearchAddon()?.findPrevious(searchInput.value);
        } else {
          getSearchAddon()?.findNext(searchInput.value);
        }
        ev.preventDefault();
      }
    });
    searchClose.addEventListener("click", toggleSearchBar);

    // Initialize modals — use getters so focus goes to whichever terminal is active
    modals.register('shortcuts', 'shortcuts-overlay', {
      get returnFocus() { return getTerm(); },
      onClose: () => getTerm()?.focus()
    });
    modals.register('edit', 'edit-overlay', {
      get returnFocus() { return getTerm(); },
      onClose: () => getTerm()?.focus()
    });
    modals.register('add', 'add-modal', {
      get returnFocus() { return getTerm(); },
      onOpen: () => {
        const keyInput = document.getElementById("key-composer-input");
        if (keyInput) keyInput.focus();
      },
      onClose: () => getTerm()?.focus()
    });
    modals.register('dictation', 'dictation-overlay', {
      get returnFocus() { return getTerm(); },
      onClose: () => getTerm()?.focus()
    });
    modals.register('settings', 'settings-overlay', {
      get returnFocus() { return getTerm(); },
      onClose: () => getTerm()?.focus()
    });

    document.fonts.ready.then(() => {
      // Fonts loaded — refit terminal since glyph metrics may have changed
      fitActiveTerminal();
    });

    applyTheme(localStorage.getItem("theme") || "auto");
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if ((localStorage.getItem("theme") || "auto") === "auto") applyTheme("auto");
    });

    // --- WebSocket ---

    // Create buffered input sender
    const inputSender = createInputSender({
      getWebSocket: () => state.connection.ws,
      getSession: () => state.session.name,
      onInput: () => wsConnection?.nudgeOnInput(),
    });

    const rawSend = (data) => inputSender.send(data);

    // Create the initial terminal now that rawSend is available.
    // When no explicit ?s= param, activation is deferred until we
    // resolve which session to attach to (or none).
    if (explicitSession) {
      terminalPool.activate(state.session.name);
    }

    // --- Layout ---

    const termContainer = document.getElementById("terminal-container");
    const bar = document.getElementById("shortcut-bar");

    // --- Joystick (composable state machine) ---
    const joystickManager = createJoystickManager({
      onSend: (sequence) => rawSend(sequence)
    });
    joystickManager.init();





    // --- Shortcuts popup (reactive component) ---

    const shortcutsPopup = createShortcutsPopup({
      onShortcutClick: (keys) => {
        sendSequence(keysToSequence(keys), rawSend);
      },
      modals
    });

    function openShortcutsPopup(items) {
      shortcutsPopup.render(document.getElementById("shortcuts-grid"), items);
      modals.open('shortcuts');
    }

    document.getElementById("shortcuts-edit-btn").addEventListener("click", () => {
      modals.close('shortcuts');
      shortcutsEditPanel.open(shortcutsStore.getState());
    });
    

    // --- Edit shortcuts (reactive component) ---

    const shortcutsEditPanel = createShortcutsEditPanel(shortcutsStore, { modals });

    // Subscribe to shortcuts changes to re-render edit list
    shortcutsStore.subscribe((shortcuts) => {
      const editList = document.getElementById("edit-list");
      if (editList && modals.get('edit')?.isOpen) {
        shortcutsEditPanel.render(editList, shortcuts);
      }
    });

    document.getElementById("edit-done").addEventListener("click", () => {
      shortcutsEditPanel.close();
    });

    document.getElementById("edit-add").addEventListener("click", () => {
      addShortcutModal.open();
    });

    // --- Add shortcut modal (reactive component) ---

    const addShortcutModal = createAddShortcutModal(shortcutsStore, {
      modals,
      keysLabel,
      keysString,
      displayKey,
      normalizeKey,
      VALID_KEYS
    });

    // Initialize the add modal event handlers
    addShortcutModal.init();

    

    // --- Session manager (render takes data) ---

    const sessionStore = createSessionStore(state.session.name);
    const windowTabSet = createWindowTabSet({
      sessionStore,
      getCurrentSession: () => state.session.name
    });
    // Ensure the initial session from the URL is in this window's tab set
    if (explicitSession) {
      windowTabSet.addTab(state.session.name);
    }

    // Create session list component
    // switchSession is defined below but the callback is only invoked on click, not during init
    const sessionListComponent = createSessionListComponent(sessionStore, {
      onSessionSwitch: (name) => switchSession(name),
      windowTabSet
    });
    const sessionListEl = document.getElementById("session-list");
    if (sessionListEl) {
      sessionListComponent.mount(sessionListEl);
    }

    // --- Sidebar toggle ---
    const sidebar = document.getElementById("sidebar");
    const sidebarToggleBtn = document.getElementById("sidebar-toggle");
    const sidebarAddBtn = document.getElementById("sidebar-add-btn");
    const sidebarBackdrop = document.getElementById("sidebar-backdrop");

    // Device-based layout: phones get sidebar overlay, tablets/desktop get tab bar
    const isOverlayViewport = () =>
      !window.matchMedia("(pointer: fine)").matches &&
      !window.matchMedia("(pointer: coarse) and (min-width: 768px)").matches;

    function loadSidebarData() {
      invalidateSessions(sessionStore, state.session.name);
    }

    function setOverlaySidebar(open) {
      if (!sidebar) return;
      sidebar.classList.toggle("mobile-open", open);
      sidebarBackdrop?.classList.toggle("visible", open);
      if (open) loadSidebarData();
    }

    function setSidebarCollapsed(collapsed) {
      if (!sidebar) return;
      sidebar.classList.toggle("collapsed", collapsed);
      localStorage.setItem("sidebar-collapsed", collapsed ? "1" : "0");
      const icon = sidebarToggleBtn?.querySelector("i");
      if (icon) {
        icon.className = collapsed ? "ph ph-caret-right" : "ph ph-caret-left";
      }
    }

    function toggleSidebar() {
      if (!sidebar) return;
      if (isOverlayViewport()) {
        setOverlaySidebar(!sidebar.classList.contains("mobile-open"));
        return;
      }
      const isCollapsed = sidebar.classList.contains("collapsed");
      setSidebarCollapsed(!isCollapsed);
      if (isCollapsed) loadSidebarData();
    }

    if (sidebarBackdrop) {
      sidebarBackdrop.addEventListener("click", () => setOverlaySidebar(false));
    }

    // Restore sidebar state from localStorage (desktop only)
    const savedCollapsed = localStorage.getItem("sidebar-collapsed");
    const isInitiallyCollapsed = savedCollapsed !== "0";
    if (!isInitiallyCollapsed && sidebar) {
      sidebar.classList.remove("collapsed");
    }
    const toggleIcon = sidebarToggleBtn?.querySelector("i");
    if (toggleIcon) {
      toggleIcon.className = isInitiallyCollapsed ? "ph ph-caret-right" : "ph ph-caret-left";
    }

    if (sidebarToggleBtn) {
      sidebarToggleBtn.addEventListener("click", toggleSidebar);
    }

    // --- New session creation (shared by sidebar + and shortcut bar +) ---
    async function createNewSession() {
      try {
        const name = `session-${Date.now().toString(36)}`;
        const data = await api.post("/sessions", { name, copyFrom: state.session.name });
        if (sidebar?.classList.contains("collapsed")) {
          setSidebarCollapsed(false);
        }
        // Re-enable reconnect if we were in empty state
        wsConnection.enableReconnect();
        windowTabSet.addTab(data.name);
        switchSession(data.name);
      } catch (err) {
        console.error("Failed to create session:", err);
        showToast(`Failed to create session: ${err.message}`);
      }
    }

    if (sidebarAddBtn) {
      sidebarAddBtn.addEventListener("click", createNewSession);
    }

    // Load session data: always on desktop (for tab bar), or when sidebar is expanded
    if (!isOverlayViewport() || !isInitiallyCollapsed) loadSidebarData();

    // --- Session switching (no page reload) ---
    let pendingSwitch = null;
    // Late-bound: viewportManager is created after activateSession but called lazily
    let _attachScrollButton = () => {};

    function activateSession(name) {
      // Close alternative views — switching sessions returns to terminal
      if (portForwardEl?.classList.contains("active")) closePortForward();
      if (fileBrowserEl?.classList.contains("active")) closeFileBrowser();
      if (notepad.isActive()) notepad.hide();
      // If the target session has an active helm session, show helm view; otherwise terminal
      if (helmActiveSessions.has(name)) {
        showHelmView();
        helmComponent?.showSession(name);
      } else if (helmViewEl?.classList.contains("active")) {
        hideHelmView();
      }

      // Ensure session is in this window's tab set
      if (!windowTabSet.hasTab(name)) {
        windowTabSet.addTab(name);
      }

      // In split mode, switch the correct pane instead of breaking the split
      if (splitManager.isSplit()) {
        const pane = splitManager.getPaneForSession(name);
        splitManager.switchPaneSession(pane, name);
        state.update('session.name', name);
        document.title = name;
        const url = new URL(window.location);
        url.searchParams.set("s", name);
        history.replaceState(null, "", url);
        if (shortcutBarInstance) shortcutBarInstance.render(name);
        invalidateSessions(sessionStore, name);

        // Switch WS session
        const ws = state.connection.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          const entry = terminalPool.get(name);
          if (entry) {
            pendingSwitch = name;
            ws.send(JSON.stringify({ type: "switch", session: name, cols: entry.term.cols, rows: entry.term.rows, cached: true }));
          }
        }
        return;
      }

      const ws = state.connection.ws;
      const wsOpen = ws && ws.readyState === WebSocket.OPEN;

      const wasCached = terminalPool.has(name);
      const entry = terminalPool.activate(name);

      // If this is a fresh terminal (not cached), clear it so we start clean
      if (!wasCached) {
        entry.term.clear();
        entry.term.reset();
      }

      // Visual updates only — state.session.name is set by the server's
      // "switched" or "attached" confirmation to avoid stale routing during
      // the switch window.
      document.title = name;

      if (wsOpen) {
        // Switch session over the existing WebSocket — no disconnect/reconnect needed
        pendingSwitch = name;
        ws.send(JSON.stringify({ type: "switch", session: name, cols: entry.term.cols, rows: entry.term.rows, cached: wasCached }));
      } else if (!ws || ws.readyState === WebSocket.CLOSED) {
        // No WebSocket yet — set session name for the attach message, then connect
        state.update('session.name', name);
        wsConnection.connect();
      }
      if (shortcutBarInstance) shortcutBarInstance.render(name);
      invalidateSessions(sessionStore, name);
      // Reflow terminal to current window size after activation
      fitActiveTerminal();
      // Attach scroll-to-bottom button listener to the new viewport.
      // scroll events don't bubble, so we must listen on the viewport directly.
      _attachScrollButton();
      // Reset outer page scroll in case the browser shifted it
      requestAnimationFrame(() => window.scrollTo(0, 0));
    }

    function switchSession(name) {
      // In split mode, allow switching even if it's the "current" session
      // (it might be active in the other pane)
      if (!splitManager.isSplit()) {
        if (name === state.session.name || name === pendingSwitch) return;
      }
      const url = new URL(window.location);
      url.searchParams.set("s", name);
      history.pushState(null, "", url);
      activateSession(name);
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    window.addEventListener("popstate", () => {
      const name = new URLSearchParams(location.search).get("s");
      if (!name) return; // bare URL without ?s= — stay on current session
      if (name !== state.session.name && name !== pendingSwitch) activateSession(name);
    });

    const openSessionManager = () => toggleSidebar();

    // --- Keyboard shortcuts (Cmd+Shift+[/], Cmd+?) ---

    function navigateTab(direction) {
      const tabs = windowTabSet.getTabs();
      if (tabs.length <= 1) return;
      const idx = tabs.indexOf(state.session.name);
      if (idx === -1) return;
      switchSession(tabs[(idx + direction + tabs.length) % tabs.length]);
    }

    function toggleKeyboardHelp() {
      const overlay = document.getElementById("kb-help-overlay");
      if (!overlay) return;
      const isVisible = overlay.classList.contains("visible");
      overlay.classList.toggle("visible", !isVisible);
      if (!isVisible) {
        const closeBtn = document.getElementById("kb-help-close");
        if (closeBtn) closeBtn.focus();
      }
    }

    // Close overlay on backdrop click or close button
    const kbHelpOverlay = document.getElementById("kb-help-overlay");
    if (kbHelpOverlay) {
      kbHelpOverlay.addEventListener("click", (ev) => {
        if (ev.target === kbHelpOverlay) toggleKeyboardHelp();
      });
      const closeBtn = document.getElementById("kb-help-close");
      if (closeBtn) closeBtn.addEventListener("click", toggleKeyboardHelp);
    }

    document.addEventListener("keydown", (ev) => {
      // Escape closes keyboard help
      if (ev.key === "Escape" && kbHelpOverlay?.classList.contains("visible")) {
        ev.preventDefault();
        toggleKeyboardHelp();
        return;
      }

      if (!ev.metaKey) return;

      // Cmd+/ — keyboard shortcuts help
      if (ev.key === "/" && !ev.shiftKey) {
        ev.preventDefault();
        toggleKeyboardHelp();
        return;
      }

      // Cmd+[ — next tab
      if (ev.key === "[" && !ev.shiftKey) {
        ev.preventDefault();
        navigateTab(+1);
        return;
      }

      // Cmd+] — previous tab
      if (ev.key === "]" && !ev.shiftKey) {
        ev.preventDefault();
        navigateTab(-1);
        return;
      }
    }, true); // Capture phase to intercept before browser defaults

    // --- Settings ---

    const settingsHandlers = createSettingsHandlers({
      onThemeChange: (theme) => applyTheme(theme),
      onInstanceIconChange: setInstanceIcon,
      onToolbarColorChange: (color) => {
        const bar = document.getElementById("shortcut-bar");
        if (bar) {
          if (color && color !== "default") {
            bar.setAttribute("data-toolbar-color", color);
          } else {
            bar.removeAttribute("data-toolbar-color");
          }
        }
        // Sync native title bar color (PWA Window Controls Overlay)
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) {
          const colorMap = {
            blue: "#89b4fa", purple: "#cba6f7", green: "#a6e3a1", red: "#f38ba8",
            orange: "#fab387", pink: "#f5c2e7", teal: "#94e2d5", yellow: "#f9e2af"
          };
          const effective = document.documentElement.getAttribute("data-theme");
          const surfaceColor = effective === "light" ? "#ffffff" : "#313244";
          metaTheme.content = (color && color !== "default") ? colorMap[color] || surfaceColor : surfaceColor;
        }
      },
      onPortProxyChange: (enabled) => {
        const btn = document.getElementById("sidebar-portfwd-btn");
        if (btn) btn.style.display = enabled ? "" : "none";
        if (shortcutBarInstance) shortcutBarInstance.setPortProxyEnabled(enabled);
        if (!enabled && portForwardEl.classList.contains("active")) {
          closePortForward();
          getTerm()?.focus();
          fitActiveTerminal();
        }
      }
    });
    settingsHandlers.init();

    // --- Settings tabs (using generic tab manager) ---
    const settingsTabManager = createTabManager({
      tabSelector: '.settings-tab',
      contentSelector: '.settings-tab-content',
      onTabChange: (targetTab) => {
        if (targetTab === "remote") {
          // Clear any lingering new token display before loading tokens
          const tokensList = document.getElementById("tokens-list");
          const staleNewToken = tokensList?.querySelector('.token-item-new');
          if (staleNewToken) staleNewToken.remove();
          loadTokens();
        }
      }
    });
    settingsTabManager.init();

    // --- Token management ---

    const tokenStore = createTokenStore();
    const loadTokens = () => reloadTokens(tokenStore);

    // Create token form manager with callbacks
    const tokenFormManager = createTokenFormManager({
      onCreate: (data) => {
        setNewToken(tokenStore, data);
      },
      onRename: () => {
        invalidateTokens(tokenStore);
      },
      onRevoke: (tokenId) => {
        removeToken(tokenStore, tokenId);
      }
    });
    tokenFormManager.init();

    // Create token list component
    const tokenListComponent = createTokenListComponent(tokenStore, {
      onRename: (tokenId) => tokenFormManager.renameToken(tokenId),
      onRevoke: (tokenId, hasCredential, isOrphaned) => tokenFormManager.revokeToken(tokenId, hasCredential, isOrphaned)
    });
    const tokensList = document.getElementById("tokens-list");
    if (tokensList) {
      tokenListComponent.mount(tokensList);
    }

    // --- Dictation modal (reactive component) ---

    const dictationModal = createDictationModal({
      modals,
      onSend: async (text, images) => {
        if (text) rawSend(text);
        for (const file of images) {
          await uploadImageToTerminal(file);
        }
      }
    });

    dictationModal.init();

    function openDictationModal() {
      dictationModal.open();
    }

    // --- Viewport manager & Shortcut bar ---
    // (Moved here after openSessionManager and openDictationModal are defined)

    const viewportManager = createViewportManager({
      term: getTerm,
      fit: getFit,
      termContainer,
      bar,
      onWebSocketResize: (cols, rows) => {
        if (state.connection.ws?.readyState === 1) {
          state.connection.ws.send(JSON.stringify({ type: "resize", session: state.session.name, cols, rows }));
        }
      }
    });
    viewportManager.init();
    _attachScrollButton = () => viewportManager.attachScrollButton();

    shortcutBarInstance = createShortcutBar({
      container: bar,
      pinnedKeys: [
        { label: "Esc", keys: "esc" },
        { label: "Tab", keys: "tab" }
      ],
      onSessionClick: openSessionManager,
      onNewSessionClick: createNewSession,
      onTabClick: (name) => switchSession(name),
      onNotepadClick: () => toggleNotepad(),
      get notepad() { return notepad; },
      onTabRenamed: (oldName, newName) => {
        windowTabSet.renameTab(oldName, newName);
        terminalPool.rename(oldName, newName);
        notepad.rename(oldName, newName);
        invalidateSessions(sessionStore, newName);
        if (state.session.name === oldName) {
          state.update('session.name', newName);
          document.title = newName;
          const url = new URL(window.location);
          url.searchParams.set("s", newName);
          history.replaceState(null, "", url);
        }
      },
      onAdoptSession: async (name) => {
        windowTabSet.addTab(name);
        try {
          const result = await api.post("/tmux-sessions/adopt", { name });
          if (result.name) switchSession(result.name);
        } catch (err) {
          // Fallback: switch directly (spawnSession auto-adopts existing tmux sessions)
          console.warn("Adopt API failed, switching directly:", err.message);
          switchSession(name);
        }
      },
      onTerminalClick: () => returnToTerminal(),
      onFilesClick: () => toggleFileBrowser(),
      onPortForwardClick: () => togglePortForward(),
      onSettingsClick: () => modals.open('settings'),
      onShortcutsClick: () => openShortcutsPopup(state.session.shortcuts),
      onDictationClick: () => openDictationModal(),
      onAllTabsClosed: () => {
        // Hide all terminal panes, disconnect WS, clear state
        terminalPool.forEach((name) => terminalPool.dispose(name));
        wsConnection.disconnect();
        state.update('session.name', null);
        document.title = "katulong";
        const url = new URL(window.location);
        url.searchParams.delete("s");
        history.replaceState(null, "", url);
      },
      onSplitDrop: (sessionName, pane) => {
        // pane 1 = left/top zone, pane 2 = right/bottom zone
        const currentActive = state.session.name;
        if (pane === 1) {
          // Dragged tab goes to pane 1 (left), current stays pane 2 (right)
          splitManager.split(sessionName, currentActive);
        } else {
          // Current stays pane 1 (left), dragged tab goes to pane 2 (right)
          splitManager.split(currentActive, sessionName);
        }
        // Protect both sessions from pool eviction
        terminalPool.protect(splitManager.getPane1());
        terminalPool.protect(splitManager.getPane2());
        // Ensure WS knows about both sessions
        const ws = state.connection.ws;
        if (ws?.readyState === WebSocket.OPEN) {
          const entry = terminalPool.get(sessionName);
          if (entry) {
            ws.send(JSON.stringify({ type: "switch", session: sessionName, cols: entry.term.cols, rows: entry.term.rows, cached: terminalPool.has(sessionName) }));
          }
        }
      },
      sendFn: rawSend,
      get term() { return getTerm(); },
      updateConnectionIndicator,
      getInstanceIcon,
      getSessionIcon,
      sessionStore,
      windowTabSet,
      splitManager,
    });

    // Re-render bar if pointer capability changes (e.g., external mouse connected)
    window.matchMedia("(pointer: fine)").addEventListener("change", () => {
      shortcutBarInstance.render(state.session.name);
    });

    const renderBar = (name) => shortcutBarInstance.render(name);

    // Sync per-session icons from server session data
    sessionStore.subscribe(() => {
      const { sessions } = sessionStore.getState();
      if (!sessions) return;
      for (const s of sessions) {
        if (s.icon) {
          sessionIcons.set(s.name, s.icon);
        } else {
          sessionIcons.delete(s.name);
        }
      }
    });

    // Subscribe to shortcuts changes to re-render bar
    shortcutsStore.subscribe((shortcuts) => {
      // Update legacy state object (for backward compatibility)
      state.update('session.shortcuts', shortcuts);

      // Re-render bar when shortcuts change
      renderBar(state.session.name);
    });



    // --- Image upload (using imported helpers) ---
    const uploadImageToTerminal = (file, sessionName) => uploadImageToTerminalFn(file, {
      onSend: rawSend,
      toast: showToast,
      sessionName: sessionName || state.session.name,
      getWebSocket: () => state.connection.ws
    });

    // --- Drag-and-drop (reactive manager) ---

    const dragDropManager = createDragDropManager({
      isImageFile,
      shouldIgnore: (e) => fileBrowserEl.classList.contains("active"),
      onDrop: async (imageFiles, totalFiles) => {
        if (imageFiles.length === 0) {
          if (totalFiles > 0) showToast("Not an image file", true);
          return;
        }
        // Upload in parallel, paste via single server request
        uploadImagesToTerminalFn(imageFiles, { onSend: rawSend, toast: showToast, sessionName: state.session.name, getWebSocket: () => state.connection.ws });
      }
    });

    dragDropManager.init();

    // --- Global paste ---

    const pasteHandler = createPasteHandler({
      getSession: () => state.session.name,
      onImage: (file, sessionName) => uploadImageToTerminal(file, sessionName),
      // Use xterm.js paste() so text is wrapped in bracketed paste
      // markers (\x1b[200~…\x1b[201~) when the app has enabled it.
      // Without this, multiline pastes arrive without brackets and
      // each newline is treated as Enter/submit by TUI apps.
      onTextPaste: (text) => {
        const term = getTerm();
        if (term) { term.paste(text); } else { rawSend(text); }
      },
    });
    pasteHandler.init();

    // --- File Browser ---

    const fileBrowserStore = createFileBrowserStore();
    const fileBrowserEl = document.getElementById("file-browser");
    let fileBrowserMounted = false;
    let fileBrowserComponent = null;

    const joystickEl = document.getElementById("joystick");

    function returnToTerminal() {
      if (portForwardEl?.classList.contains("active")) closePortForward();
      if (fileBrowserEl?.classList.contains("active")) closeFileBrowser();
      if (notepad.isActive()) notepad.hide();
      if (helmViewEl?.classList.contains("active")) hideHelmView();
      getTerm()?.focus();
      fitActiveTerminal();
    }

    function closePortForward() {
      portForwardEl.classList.remove("active");
      termContainer.classList.remove("pf-hidden");
      bar.style.display = "";
      if (joystickEl) joystickEl.style.display = "";
    }

    function closeFileBrowser() {
      fileBrowserEl.classList.remove("active");
      termContainer.classList.remove("fb-hidden");
    }

    function toggleFileBrowser() {
      const isActive = fileBrowserEl.classList.contains("active");
      if (isActive) {
        closeFileBrowser();
        getTerm()?.focus();
        fitActiveTerminal();
      } else {
        // Close other panels if open (mutual exclusion)
        if (portForwardEl.classList.contains("active")) closePortForward();
        if (!fileBrowserMounted) {
          fileBrowserComponent = createFileBrowserComponent(fileBrowserStore, {
            onClose: () => toggleFileBrowser(),
          });
          fileBrowserComponent.mount(fileBrowserEl);
          fileBrowserMounted = true;
          loadRoot(fileBrowserStore, "");
        }
        termContainer.classList.add("fb-hidden");
        fileBrowserEl.classList.add("active");
        fileBrowserComponent.focus();
      }
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    // --- Port Forward ---

    const portForwardEl = document.getElementById("port-forward");
    let portForwardMounted = false;
    let portForwardComponent = null;

    function togglePortForward() {
      const isActive = portForwardEl.classList.contains("active");
      if (isActive) {
        closePortForward();
        getTerm()?.focus();
        fitActiveTerminal();
      } else {
        // Close other panels if open (mutual exclusion)
        if (fileBrowserEl.classList.contains("active")) closeFileBrowser();
        if (!portForwardMounted) {
          portForwardComponent = createPortForwardComponent({
            onClose: () => togglePortForward(),
          });
          portForwardComponent.mount(portForwardEl);
          portForwardMounted = true;
        }
        termContainer.classList.add("pf-hidden");
        portForwardEl.classList.add("active");
        bar.style.display = "none";
        if (joystickEl) joystickEl.style.display = "none";
        portForwardComponent.focus();
      }
      if (isOverlayViewport()) setOverlaySidebar(false);
    }

    const sidebarFilesBtn = document.getElementById("sidebar-files-btn");
    if (sidebarFilesBtn) {
      sidebarFilesBtn.addEventListener("click", toggleFileBrowser);
    }

    const sidebarPortfwdBtn = document.getElementById("sidebar-portfwd-btn");
    if (sidebarPortfwdBtn) {
      sidebarPortfwdBtn.addEventListener("click", togglePortForward);
    }

    const sidebarSettingsBtn = document.getElementById("sidebar-settings-btn");
    if (sidebarSettingsBtn) {
      sidebarSettingsBtn.addEventListener("click", () => modals.open('settings'));
    }

    // --- Notepad ---

    const notepad = createNotepad({
      onClose: () => getTerm()?.focus(),
    });

    function toggleNotepad() {
      if (notepad.isActive()) {
        notepad.hide();
      } else {
        notepad.show(state.session.name);
      }
    }

    // --- Helm Mode ---

    const helmViewEl = document.getElementById("helm-view");
    let helmMounted = false;
    let helmComponent = null;
    // Track which sessions are in helm mode (per-session, not global)
    const helmActiveSessions = new Set();

    function ensureHelmMounted() {
      if (helmMounted) return;
      helmComponent = createHelmComponent({
        onSendMessage: (session, content) => {
          const ws = state.connection.ws;
          if (ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: "helm-input", session, content }));
          }
        },
        onAbort: (session) => {
          const ws = state.connection.ws;
          if (ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: "helm-abort", session }));
          }
        },
        onToggleTerminal: () => toggleHelmView(),
      });
      helmComponent.mount(helmViewEl);
      helmMounted = true;
    }

    function showHelmView() {
      ensureHelmMounted();
      if (fileBrowserEl?.classList.contains("active")) closeFileBrowser();
      if (portForwardEl?.classList.contains("active")) closePortForward();
      termContainer.classList.add("helm-hidden");
      helmViewEl.classList.add("active");
      helmComponent.showSession(state.session.name);
      helmComponent.focus();
    }

    function hideHelmView() {
      helmViewEl.classList.remove("active");
      termContainer.classList.remove("helm-hidden");
      getTerm()?.focus();
      fitActiveTerminal();
    }

    function toggleHelmView() {
      if (helmViewEl.classList.contains("active")) {
        hideHelmView();
      } else if (helmActiveSessions.has(state.session.name)) {
        showHelmView();
      }
    }

    function onHelmModeChanged(effect) {
      if (effect.active) {
        helmActiveSessions.add(effect.session);
        ensureHelmMounted();
        helmComponent.helmStarted(effect.session, {
          agent: effect.agent,
          prompt: effect.prompt,
          cwd: effect.cwd,
        });
        // Auto-switch to helm view if this is the active session
        if (effect.session === state.session.name) {
          showHelmView();
        }
      } else {
        helmActiveSessions.delete(effect.session);
        helmComponent?.helmEnded(effect.session, {
          result: effect.result,
          error: effect.error,
        });
        // If viewing helm for this session and it ended, switch back to terminal
        if (effect.session === state.session.name && helmViewEl.classList.contains("active")) {
          hideHelmView();
        }
      }
      // Re-render the tab bar to show/hide helm indicator
      renderBar(state.session.name);
    }

    // --- Network change monitoring ---

    const networkMonitor = createNetworkMonitor({
      onNetworkChange: () => {
        // Network changed — WebSocket will handle reconnection if needed
      }
    });
    networkMonitor.init();

    // --- WebSocket Connection ---

    const wsConnection = createWebSocketConnection({
      term: getTerm,
      getTermForSession: (session) => terminalPool.get(session)?.term || null,
      state,
      updateConnectionIndicator,
      isAtBottom,
      invalidateSessions: (name) => invalidateSessions(sessionStore, name),
      updateSessionUI: (name) => {
        pendingSwitch = null;
        document.title = name;
        const url = new URL(window.location);
        url.searchParams.set("s", name);
        history.replaceState(null, "", url);
        renderBar(name);
      },
      refreshTokensAfterRegistration: () => {
        loadTokens();
        const form = document.getElementById("token-create-form");
        const btn = document.getElementById("settings-create-token");
        if (form) form.style.display = "none";
        if (btn) btn.style.display = "";
      },
      onSessionRemoved: (name) => {
        windowTabSet.onSessionKilled(name);
        terminalPool.dispose(name);
        fetch("/sessions").then(r => r.json()).then(allSessions => {
          // Filter out the session that was just removed (may still be in the response)
          const sessions = allSessions.filter(s => s.name !== name);
          if (sessions.length > 0) {
            const next = sessions[0].name;
            switchSession(next);
          } else {
            // No sessions left — disconnect WS, clear UI, stay on page
            wsConnection.disconnect();
            state.update('session.name', null);
            document.title = "katulong";
            const url = new URL(window.location);
            url.searchParams.delete("s");
            history.replaceState(null, "", url);
            renderBar(null);
          }
        }).catch(() => {
          wsConnection.disconnect();
          state.update('session.name', null);
          document.title = "katulong";
        });
      },
      onDisconnect: () => { pendingSwitch = null; },
      poolRename: (oldName, newName) => terminalPool.rename(oldName, newName),
      tabRename: (oldName, newName) => windowTabSet.renameTab(oldName, newName),
      fit: fitActiveTerminal,
      setSyncResize: (v) => viewportManager.setSyncResize(v),
      // Helm mode
      onHelmModeChanged,
      onHelmEvent: (session, event) => helmComponent?.helmEvent(session, event),
      onHelmTurnComplete: (session) => helmComponent?.helmTurnComplete(session),
      onHelmWaitingForInput: (session) => helmComponent?.helmWaitingForInput(session),
      onPasteComplete: (path) => onPasteComplete(path),
      onTabIconChanged: (session, icon) => {
        if (icon) {
          sessionIcons.set(session, icon);
        } else {
          sessionIcons.delete(session);
        }
        if (shortcutBarInstance) shortcutBarInstance.render(state.session.name);
      },
    });
    wsConnection.initVisibilityReconnect();

    // --- Boot ---

    // If no explicit ?s= param, resolve an existing session before connecting
    // to avoid creating a throwaway "default" tmux session.
    // If user explicitly closed all tabs, stay in empty state.
    const wasEmptyState = sessionStorage.getItem("katulong-empty-state");
    if (wasEmptyState) sessionStorage.removeItem("katulong-empty-state");

    if (!explicitSession) {
      fetch("/sessions").then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }).then(sessions => {
        // Guard: if the user already picked a session while the fetch was in-flight, skip
        if (state.connection.ws || state.session.name !== null) return;
        // If user explicitly closed all tabs, don't auto-attach
        if (wasEmptyState) return;
        if (sessions.length > 0 && sessions[0].name) {
          const name = sessions[0].name;
          state.update('session.name', name);
          document.title = name;
          const url = new URL(window.location);
          url.searchParams.set("s", name);
          history.replaceState(null, "", url);
          terminalPool.activate(name);
          renderBar(name);
          windowTabSet.addTab(name);
          wsConnection.connect();
        }
        // If no sessions exist, stay empty — user can create one via session list
      }).catch((err) => {
        console.warn("Failed to fetch sessions on load:", err);
        // Stay empty rather than creating a throwaway "default" session.
        // User can create or pick a session via the sidebar.
      });
    } else {
      renderBar(state.session.name);
      wsConnection.connect();
    }
    loadShortcuts();
    getTerm()?.focus();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
