    import { Terminal } from "/vendor/xterm/xterm.esm.js";
    import { FitAddon } from "/vendor/xterm/addon-fit.esm.js";
    import { WebLinksAddon } from "/vendor/xterm/addon-web-links.esm.js";
    import { WebglAddon } from "/vendor/xterm/addon-webgl.esm.js";
    import { SearchAddon } from "/vendor/xterm/addon-search.esm.js";
    import { ClipboardAddon } from "/vendor/xterm/addon-clipboard.esm.js";
    import { ModalRegistry } from "/lib/modal.js";
    import {
      createSessionStore, invalidateSessions,
      createTokenStore, setNewToken, invalidateTokens, removeToken, loadTokens as reloadTokens,
      createShortcutsStore, loadShortcuts as reloadShortcuts,
    } from "/lib/stores.js";
    import { createSessionListComponent, updateSnapshot } from "/lib/session-list-component.js";
    import { createSessionManager } from "/lib/session-manager.js";
    import { api } from "/lib/api-client.js";
    import { createTokenListComponent } from "/lib/token-list-component.js";
    import { createTokenFormManager } from "/lib/token-form.js";
    import { createShortcutsPopup, createShortcutsEditPanel, createAddShortcutModal } from "/lib/shortcuts-components.js";
    import { createDictationModal } from "/lib/dictation-modal.js";
    import { createDragDropManager } from "/lib/drag-drop.js";
    import { showToast, isImageFile, uploadImageToTerminal as uploadImageToTerminalFn } from "/lib/image-upload.js";
    import { createJoystickManager } from "/lib/joystick.js";
    import { createPullToRefreshManager } from "/lib/pull-to-refresh.js";
    import { createThemeManager, DARK_THEME, LIGHT_THEME } from "/lib/theme-manager.js";
    import { createTabManager } from "/lib/tab-manager.js";
    import { isAtBottom, scrollToBottom, withPreservedScroll, terminalWriteWithScroll } from "/lib/scroll-utils.js";
    import { keysToSequence, sendSequence, displayKey, keysLabel, keysString, VALID_KEYS, normalizeKey } from "/lib/key-mapping.js";
    import { createShortcutBar } from "/lib/shortcut-bar.js";
    import { createPasteHandler } from "/lib/paste-handler.js";
    import { createNetworkMonitor } from "/lib/network-monitor.js";
    import { createP2PManager, createP2PIndicator } from "/lib/p2p-manager.js";
    import { createSettingsHandlers } from "/lib/settings-handlers.js";
    import { createTerminalKeyboard } from "/lib/terminal-keyboard.js";
    import { createInputSender } from "/lib/input-sender.js";
    import { createViewportManager } from "/lib/viewport-manager.js";
    import { createWebSocketConnection } from "/lib/websocket-connection.js";
    import { createFileBrowserStore, loadRoot } from "/lib/file-browser/file-browser-store.js";
    import { createFileBrowserComponent } from "/lib/file-browser/file-browser-component.js";

    // --- Modal Manager ---
    const modals = new ModalRegistry();

    // Modal registration imported from /lib/modal-init.js

    // --- Theme (using composable theme manager) ---
    const themeManager = createThemeManager({
      onThemeChange: (themeData) => {
        withPreservedScroll(term, () => {
          term.options.theme = themeData;
        });
      }
    });

    const applyTheme = themeManager.apply;

    // --- State ---

    // --- Centralized application state (at edge) ---
    const createAppState = () => {
      const initialSessionName = new URLSearchParams(location.search).get("s") || "default";

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
        p2p: {
          peer: null,
          connected: false,
          retryTimer: 0,
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

    // --- P2P Manager ---

    // Initialize P2P manager
    const p2pManager = createP2PManager({
      onStateChange: (p2pState) => {
        state.update('p2p.connected', p2pState.connected);
        state.update('p2p.peer', p2pState.peer);
        updateP2PIndicator();
      },
      onData: (str) => {
        try {
          const msg = JSON.parse(str);
          if (msg.type === "output") {
            term.write(msg.data);
          }
        } catch {
          // ignore malformed P2P data
        }
      },
      getWS: () => state.connection.ws
    });

    // P2P UI indicator
    const p2pIndicator = createP2PIndicator({
      p2pManager,
      getConnectionState: () => ({ attached: state.connection.attached })
    });
    const updateP2PIndicator = () => {
      p2pIndicator.update();
      // Sync sidebar connection dot
      const sidebarDot = document.getElementById("sidebar-p2p-dot");
      if (sidebarDot) {
        const attached = state.connection.attached;
        const p2pConnected = state.p2p.connected;
        sidebarDot.classList.toggle("connected", attached || p2pConnected);
        sidebarDot.classList.toggle("disconnected", !attached && !p2pConnected);
        sidebarDot.title = p2pConnected ? "Connected (direct)" : attached ? "Connected (relay)" : "Disconnected";
      }
    };

    document.title = state.session.name;

    // --- Terminal setup ---

    const term = new Terminal({
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
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    term.loadAddon(new ClipboardAddon());
    term.open(document.getElementById("terminal-container"));

    // WebGL renderer (GPU-accelerated) with graceful fallback.
    // Only loads when a real GPU is available — skips software renderers
    // (SwiftShader in headless browsers) that break xterm's DOM rendering.
    try {
      const testCanvas = document.createElement("canvas");
      const gl = testCanvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
      if (gl) {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      }
    } catch {
      console.warn("WebGL renderer unavailable, using default canvas renderer");
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
        searchAddon.clearDecorations();
        term.focus();
      }
    }

    searchInput.addEventListener("input", () => {
      if (searchInput.value) {
        searchAddon.findNext(searchInput.value);
      } else {
        searchAddon.clearDecorations();
      }
    });
    searchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        toggleSearchBar();
        ev.preventDefault();
      } else if (ev.key === "Enter") {
        if (ev.shiftKey) {
          searchAddon.findPrevious(searchInput.value);
        } else {
          searchAddon.findNext(searchInput.value);
        }
        ev.preventDefault();
      }
    });
    searchClose.addEventListener("click", toggleSearchBar);

    // Initialize modals with terminal reference
    modals.register('shortcuts', 'shortcuts-overlay', {
      returnFocus: term,
      onClose: () => term.focus()
    });
    modals.register('edit', 'edit-overlay', {
      returnFocus: term,
      onClose: () => term.focus()
    });
    modals.register('add', 'add-modal', {
      returnFocus: term,
      onOpen: () => {
        const keyInput = document.getElementById("key-composer-input");
        if (keyInput) keyInput.focus();
      },
      onClose: () => term.focus()
    });
    // Session sidebar (no longer a modal)
    modals.register('dictation', 'dictation-overlay', {
      returnFocus: term,
      onClose: () => term.focus()
    });
    modals.register('settings', 'settings-overlay', {
      returnFocus: term,
      onClose: () => term.focus()
    });

    // Disable mobile autocorrect/suggestions on xterm's hidden textarea
    function patchTextarea() {
      const ta = document.querySelector(".xterm-helper-textarea");
      if (!ta || ta._patched) return;
      ta._patched = true;
      ta.setAttribute("autocorrect", "off");
      ta.setAttribute("autocapitalize", "none");
      ta.setAttribute("autocomplete", "new-password");
      ta.setAttribute("spellcheck", "false");
      ta.autocomplete = "new-password";
      ta.autocapitalize = "none";
      ta.spellcheck = false;
      ta.addEventListener("compositionstart", (e) => e.preventDefault());
    }
    patchTextarea();
    new MutationObserver(patchTextarea).observe(
      document.getElementById("terminal-container"),
      { childList: true, subtree: true }
    );
    document.fonts.ready.then(() => {
      withPreservedScroll(term, () => fit.fit());
      // Ensure we start at bottom on initial page load
      scrollToBottom(term);
    });

    applyTheme(localStorage.getItem("theme") || "auto");
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if ((localStorage.getItem("theme") || "auto") === "auto") applyTheme("auto");
    });

    // --- WebSocket ---

    // Create buffered input sender
    const inputSender = createInputSender({
      p2pManager,
      getWebSocket: () => state.connection.ws
    });

    const rawSend = (data) => inputSender.send(data);

    // Initialize terminal keyboard handlers
    const terminalKeyboard = createTerminalKeyboard({
      term,
      onSend: rawSend,
      onToggleSearch: toggleSearchBar
    });
    terminalKeyboard.init();

    // WebSocket connection setup moved to after all dependencies are initialized (see before Boot section)

    // --- Layout ---

    const termContainer = document.getElementById("terminal-container");
    const bar = document.getElementById("shortcut-bar");

    // --- Joystick (composable state machine) ---
    const joystickManager = createJoystickManager({
      onSend: (sequence) => rawSend(sequence)
    });
    joystickManager.init();



    // --- Pull-to-refresh (composable gesture handler) ---
    const pullToRefresh = createPullToRefreshManager({
      container: termContainer,
      isAtBottom,
      onRefresh: () => {
        if (state.connection.ws && state.connection.ws.readyState === WebSocket.OPEN && state.connection.attached) {
          rawSend("\x0C"); // Ctrl-L: refresh screen
        } else {
          if (state.connection.ws) state.connection.ws.close();
        }
      }
    });
    pullToRefresh.init();

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

    // Create session list component
    // switchSession is defined below but the callback is only invoked on click, not during init
    const sessionListComponent = createSessionListComponent(sessionStore, {
      onSessionSwitch: (name) => switchSession(name)
    });
    const sessionListEl = document.getElementById("session-list");
    if (sessionListEl) {
      sessionListComponent.mount(sessionListEl);
    }

    // SSH password reveal/copy (sidebar)
    const sessionManager = createSessionManager();
    sessionManager.init();

    // --- Sidebar toggle ---
    const sidebar = document.getElementById("sidebar");
    const sidebarToggleBtn = document.getElementById("sidebar-toggle");
    const sidebarAddBtn = document.getElementById("sidebar-add-btn");
    const sidebarBackdrop = document.getElementById("sidebar-backdrop");

    const isMobile = () => window.matchMedia("(max-width: 767px)").matches;

    function loadSidebarData() {
      invalidateSessions(sessionStore, state.session.name);
      api.get("/ssh/password").then(({ password }) => {
        const pwInput = document.getElementById("ssh-password-value");
        if (pwInput) pwInput.value = password;
      }).catch(() => {});
    }

    function setMobileSidebar(open) {
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
      if (isMobile()) {
        setMobileSidebar(!sidebar.classList.contains("mobile-open"));
        return;
      }
      const isCollapsed = sidebar.classList.contains("collapsed");
      setSidebarCollapsed(!isCollapsed);
      if (isCollapsed) loadSidebarData();
    }

    if (sidebarBackdrop) {
      sidebarBackdrop.addEventListener("click", () => setMobileSidebar(false));
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
        switchSession(data.name);
      } catch (err) {
        console.error("Failed to create session:", err);
      }
    }

    if (sidebarAddBtn) {
      sidebarAddBtn.addEventListener("click", createNewSession);
    }

    if (!isInitiallyCollapsed) loadSidebarData();

    // --- Session switching (no page reload) ---
    function activateSession(name) {
      state.update('session.name', name);
      document.title = name;
      term.clear();
      term.reset();
      if (state.connection.ws && state.connection.ws.readyState === WebSocket.OPEN) {
        state.connection.ws.close();
      }
      if (shortcutBarInstance) shortcutBarInstance.render(name);
      invalidateSessions(sessionStore, name);
    }

    function switchSession(name) {
      if (name === state.session.name) return;
      const url = new URL(window.location);
      url.searchParams.set("s", name);
      history.pushState(null, "", url);
      activateSession(name);
      if (isMobile()) setMobileSidebar(false);
    }

    window.addEventListener("popstate", () => {
      const name = new URLSearchParams(location.search).get("s") || "default";
      if (name !== state.session.name) activateSession(name);
    });

    const openSessionManager = () => toggleSidebar();
    

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
      term,
      fit,
      termContainer,
      bar,
      onWebSocketResize: (cols, rows) => {
        if (state.connection.ws?.readyState === 1) {
          state.connection.ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      },
      onDictationOpen: () => openDictationModal()
    });
    viewportManager.init();

    shortcutBarInstance = createShortcutBar({
      container: bar,
      pinnedKeys: [
        { label: "Esc", keys: "esc" },
        { label: "Tab", keys: "tab" }
      ],
      onSessionClick: openSessionManager,
      onNewSessionClick: createNewSession,
      onShortcutsClick: () => openShortcutsPopup(state.session.shortcuts),
      sendFn: rawSend,
      term,
      updateP2PIndicator,
      getInstanceIcon
    });

    const renderBar = (name) => shortcutBarInstance.render(name);

    // Subscribe to shortcuts changes to re-render bar
    shortcutsStore.subscribe((shortcuts) => {
      // Update legacy state object (for backward compatibility)
      state.update('session.shortcuts', shortcuts);

      // Re-render bar when shortcuts change
      renderBar(state.session.name);
    });



    // --- Image upload (using imported helpers) ---
    const uploadImageToTerminal = (file) => uploadImageToTerminalFn(file, {
      onSend: rawSend,
      toast: showToast
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
        for (const file of imageFiles) {
          // Write image to system clipboard and send Ctrl+V so CLI tools
          // (like Claude Code) detect it the same way as a native paste.
          try {
            const blob = new Blob([await file.arrayBuffer()], { type: file.type });
            await navigator.clipboard.write([new ClipboardItem({ [file.type]: blob })]);
            rawSend("\x16"); // Ctrl+V triggers clipboard read in the PTY app
          } catch {
            // Fallback: upload and send absolute filesystem path
            uploadImageToTerminal(file);
          }
        }
      }
    });

    dragDropManager.init();

    // --- Global paste ---

    const pasteHandler = createPasteHandler({
      onImage: (file) => uploadImageToTerminal(file)
    });
    pasteHandler.init();

    // --- File Browser ---

    const fileBrowserStore = createFileBrowserStore();
    const fileBrowserEl = document.getElementById("file-browser");
    let fileBrowserMounted = false;
    let fileBrowserComponent = null;

    function toggleFileBrowser() {
      const isActive = fileBrowserEl.classList.contains("active");
      if (isActive) {
        // Switch back to terminal
        fileBrowserEl.classList.remove("active");
        termContainer.classList.remove("fb-hidden");
        term.focus();
        // Wait one frame for layout to recalculate before fitting
        requestAnimationFrame(() => withPreservedScroll(term, () => fit.fit()));
      } else {
        // Switch to file browser
        if (!fileBrowserMounted) {
          fileBrowserComponent = createFileBrowserComponent(fileBrowserStore, {
            onClose: () => toggleFileBrowser(),
          });
          fileBrowserComponent.mount(fileBrowserEl);
          fileBrowserMounted = true;
          // Load home directory as first column
          loadRoot(fileBrowserStore, "");
        }
        termContainer.classList.add("fb-hidden");
        fileBrowserEl.classList.add("active");
        fileBrowserComponent.focus();
      }
      // Close mobile sidebar when toggling
      if (isMobile()) setMobileSidebar(false);
    }

    const sidebarFilesBtn = document.getElementById("sidebar-files-btn");
    if (sidebarFilesBtn) {
      sidebarFilesBtn.addEventListener("click", toggleFileBrowser);
    }

    const sidebarSettingsBtn = document.getElementById("sidebar-settings-btn");
    if (sidebarSettingsBtn) {
      sidebarSettingsBtn.addEventListener("click", () => modals.open('settings'));
    }

    // --- Network change monitoring ---

    const networkMonitor = createNetworkMonitor({
      onNetworkChange: () => {
        if (!state.connection.ws || state.connection.ws.readyState !== 1) return;
        p2pManager.create();
      }
    });
    networkMonitor.init();

    // --- WebSocket Connection ---

    const wsConnection = createWebSocketConnection({
      term,
      state,
      p2pManager,
      updateP2PIndicator,
      loadTokens,
      isAtBottom,
      renderBar
    });
    wsConnection.initVisibilityReconnect();

    // --- Terminal preview for session cards ---
    // Read xterm's text buffer after renders (throttled) for sidebar previews.
    // Uses a trailing-edge timer so the last render in a burst is always captured,
    // even if the terminal goes idle before the throttle window expires.
    let lastSnapshotTime = 0;
    let snapshotTimer = null;
    term.onRender(() => {
      const now = Date.now();
      const elapsed = now - lastSnapshotTime;
      if (elapsed < 3000) {
        if (!snapshotTimer) {
          snapshotTimer = setTimeout(() => {
            snapshotTimer = null;
            lastSnapshotTime = Date.now();
            updateSnapshot(state.session.name, term);
          }, 3000 - elapsed);
        }
        return;
      }
      if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
      lastSnapshotTime = now;
      updateSnapshot(state.session.name, term);
    });

    // --- Boot ---

    renderBar(state.session.name);  // Initial render
    wsConnection.connect();
    loadShortcuts();
    term.focus();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
