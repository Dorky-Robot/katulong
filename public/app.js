    import { Terminal } from "/vendor/xterm/xterm.esm.js";
    import { FitAddon } from "/vendor/xterm/addon-fit.esm.js";
    import { WebLinksAddon } from "/vendor/xterm/addon-web-links.esm.js";
    import { getOrCreateDeviceId, generateDeviceName } from "/lib/device.js";
    import { ModalRegistry } from "/lib/modal.js";
    import { ListRenderer } from "/lib/list-renderer.js";
    import { createStore, createReducer } from "/lib/store.js";
    import { createWizardStore, WIZARD_STATES, WIZARD_ACTIONS } from "/lib/wizard-state.js";
    import { createWizardController } from "/lib/wizard-controller.js";
    import { createDeviceStore, loadDevices as reloadDevices, invalidateDevices } from "/lib/device-store.js";
    import { createDeviceListComponent } from "/lib/device-list-component.js";
    import { createDeviceActions } from "/lib/device-actions.js";
    import { createWizardComponent } from "/lib/wizard-component.js";
    import { createSessionStore, invalidateSessions } from "/lib/session-store.js";
    import { createSessionListComponent } from "/lib/session-list-component.js";
    import { createSessionManager } from "/lib/session-manager.js";
    import { createTokenStore, setNewToken, invalidateTokens, loadTokens as reloadTokens } from "/lib/token-store.js";
    import { createTokenListComponent } from "/lib/token-list-component.js";
    import { createTokenFormManager } from "/lib/token-form.js";
    import { createShortcutsStore } from "/lib/shortcuts-store.js";
    import { createShortcutsPopup, createShortcutsEditPanel, createAddShortcutModal } from "/lib/shortcuts-components.js";
    import { createDictationModal } from "/lib/dictation-modal.js";
    import { createDragDropManager } from "/lib/drag-drop.js";
    import { showToast, isImageFile, uploadImage, uploadImageToTerminal as uploadImageToTerminalFn } from "/lib/image-upload.js";
    import { createJoystickManager } from "/lib/joystick.js";
    import { createPullToRefreshManager } from "/lib/pull-to-refresh.js";
    import { createThemeManager, DARK_THEME, LIGHT_THEME } from "/lib/theme-manager.js";
    import { createTabManager } from "/lib/tab-manager.js";
    import { getCsrfToken, addCsrfHeader } from "/lib/csrf.js";
    import { isAtBottom, scrollToBottom, withPreservedScroll, terminalWriteWithScroll } from "/lib/scroll-utils.js";
    import { keysToSequence, sendSequence, displayKey, keysLabel, keysString, VALID_KEYS, normalizeKey } from "/lib/key-mapping.js";
    import { createShortcutBar } from "/lib/shortcut-bar.js";
    import { createPasteHandler } from "/lib/paste-handler.js";
    import { createNetworkMonitor } from "/lib/network-monitor.js";
    import { createP2PManager } from "/lib/p2p-manager.js";
    import { createSettingsHandlers } from "/lib/settings-handlers.js";
    import { createTerminalKeyboard } from "/lib/terminal-keyboard.js";
    import { createInputSender } from "/lib/input-sender.js";
    import { createP2PIndicator } from "/lib/p2p-ui.js";
    import { loadQRLib, getConnectInfo, checkPairingStatus } from "/lib/wizard-utils.js";
    import { initModals } from "/lib/modal-init.js";
    import { createViewportManager } from "/lib/viewport-manager.js";
    import { createWebSocketConnection } from "/lib/websocket-connection.js";

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

    // --- Device ID Management ---
    // Device management functions imported from /lib/device.js

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
          RETRY_MS: 3000
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

    // --- Shortcuts state management (reactive store) ---
    const shortcutsStore = createShortcutsStore();

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
            terminalWriteWithScroll(term, msg.data);
          }
        } catch {
          terminalWriteWithScroll(term, str);
        }
      },
      getWS: () => state.connection.ws
    });

    // P2P UI indicator
    const p2pIndicator = createP2PIndicator({
      p2pManager,
      getConnectionState: () => ({ attached: state.connection.attached })
    });
    const updateP2PIndicator = () => p2pIndicator.update();

    document.title = state.session.name;

    // --- Terminal setup ---

    const term = new Terminal({
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
      theme: themeManager.getEffective() === "light" ? LIGHT_THEME : DARK_THEME,
      cursorBlink: true,
      scrollback: 10000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(document.getElementById("terminal-container"));

    // Initialize modals with terminal reference
    initModals(modals, term);

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
      onSend: rawSend
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
          console.log("[Pull-refresh] Connected - sending Ctrl-L");
          rawSend("\x0C"); // Ctrl-L: refresh screen
        } else {
          console.log("[Pull-refresh] Disconnected - forcing reconnect");
          if (state.connection.ws) state.connection.ws.close();
        }
      }
    });
    pullToRefresh.init();


    // Viewport manager (handles resize, scroll button, terminal gestures)
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

    // --- Shortcut bar (composable renderer) ---

    const shortcutBar = createShortcutBar({
      container: bar,
      pinnedKeys: [
        { label: "Esc", keys: "esc" },
        { label: "Tab", keys: "tab" }
      ],
      onSessionClick: openSessionManager,
      onShortcutsClick: () => openShortcutsPopup(state.session.shortcuts),
      onSettingsClick: () => modals.open('settings'),
      sendFn: rawSend,
      term,
      updateP2PIndicator
    });

    const renderBar = (name) => shortcutBar.render(name);

    // Subscribe to shortcuts changes to re-render bar
    shortcutsStore.subscribe((shortcuts) => {
      // Update legacy state object (for backward compatibility)
      state.update('session.shortcuts', shortcuts);

      // Re-render bar when shortcuts change
      renderBar(state.session.name);
    });

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
      if (editList && modals.isOpen && modals.isOpen('edit')) {
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
    const sessionListComponent = createSessionListComponent(sessionStore);
    const sessionListEl = document.getElementById("session-list");
    if (sessionListEl) {
      sessionListComponent.mount(sessionListEl);
    }

    // Create session manager with callbacks
    const sessionManager = createSessionManager({
      modals,
      sessionStore,
      onSessionCreate: () => invalidateSessions(sessionStore, state.session.name)
    });
    sessionManager.init();

    // Expose openSessionManager for external use
    const openSessionManager = () => sessionManager.openSessionManager(state.session.name);
    

    // --- Settings ---

    const settingsHandlers = createSettingsHandlers({
      onThemeChange: (theme) => applyTheme(theme)
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

    // --- Device management (reactive component) ---

    const deviceStore = createDeviceStore();

    // Create device actions with callbacks
    const deviceActions = createDeviceActions({
      onRename: () => invalidateDevices(deviceStore),
      onRemove: () => invalidateDevices(deviceStore)
    });

    // Create and mount device list component
    const deviceListComponent = createDeviceListComponent(deviceStore, {
      onRename: (deviceId) => deviceActions.renameDevice(deviceId),
      onRemove: (deviceId, isCurrent) => deviceActions.removeDevice(deviceId, isCurrent)
    });
    const devicesList = document.getElementById("devices-list");
    deviceListComponent.mount(devicesList);

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
      onRevoke: () => {
        invalidateTokens(tokenStore);
      }
    });
    tokenFormManager.init();

    // Create token list component
    const tokenListComponent = createTokenListComponent(tokenStore, {
      onRename: (tokenId) => tokenFormManager.renameToken(tokenId),
      onRevoke: (tokenId, hasCredential) => tokenFormManager.revokeToken(tokenId, hasCredential)
    });
    const tokensList = document.getElementById("tokens-list");
    if (tokensList) {
      tokenListComponent.mount(tokensList);
    }

    

    // --- Inline pairing wizard ---

    const settingsViews = document.getElementById("settings-views");
    const viewMain = document.getElementById("settings-view-main");
    const viewTrust = document.getElementById("settings-view-trust");
    const viewPair = document.getElementById("settings-view-pair");
    const viewSuccess = document.getElementById("settings-view-success");

    // --- Wizard state management with reactive component ---
    const wizardStore = createWizardStore();

    // Wizard utilities imported from /lib/wizard-utils.js

    // Create wizard controller
    const wizardController = createWizardController({
      wizardStore,
      settingsViews,
      viewMain,
      viewTrust,
      viewPair,
      viewSuccess,
      deviceStore,
      modals,
      onDeviceInvalidate: () => invalidateDevices(deviceStore)
    });
    wizardController.init();

    // Extract functions for external use
    const switchSettingsView = (view) => wizardController.switchSettingsView(view);
    const stopWizardPairing = () => wizardController.cleanupWizard();

    // Create wizard component (handles all rendering automatically)
    const wizardComponent = createWizardComponent(wizardStore, {
      loadQRLib,
      getConnectInfo,
      checkPairingStatus,
      onSuccess: () => {
        wizardStore.dispatch({ type: WIZARD_ACTIONS.PAIRING_SUCCESS });
        switchSettingsView(viewSuccess);
        invalidateDevices(deviceStore);
      }
    });

    // Mount wizard component to settings views container
    wizardComponent.mount(settingsViews);

    // Expose for WebSocket handler compatibility
    Object.defineProperty(window, 'wizardActivePairCode', {
      get: () => wizardStore.getState().pairCode
    });

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

    

    // --- Image upload (using imported helpers) ---
    const uploadImageToTerminal = (file) => uploadImageToTerminalFn(file, {
      onSend: rawSend,
      toast: showToast
    });

    // --- Drag-and-drop (reactive manager) ---

    const dragDropManager = createDragDropManager({
      isImageFile,
      onDrop: (imageFiles, totalFiles) => {
        if (imageFiles.length === 0) {
          if (totalFiles > 0) showToast("Not an image file", true);
          return;
        }
        for (const file of imageFiles) uploadImageToTerminal(file);
      }
    });

    dragDropManager.init();

    // --- Global paste ---

    const pasteHandler = createPasteHandler({
      onText: (text) => rawSend(text),
      onImage: (file) => uploadImageToTerminal(file)
    });
    pasteHandler.init();

    // --- Network change: re-establish P2P ---

    const networkMonitor = createNetworkMonitor({
      onNetworkChange: () => {
        if (!state.connection.ws || state.connection.ws.readyState !== 1) return;
        console.log("[P2P] Network change detected, re-establishing");
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
      stopWizardPairing,
      switchSettingsView,
      viewSuccess,
      loadTokens,
      getWizardActivePairCode: () => window.wizardActivePairCode,
      isAtBottom,
      renderBar
    });
    wsConnection.initVisibilityReconnect();

    // --- Boot ---

    renderBar(state.session.name);  // Initial render
    wsConnection.connect();
    loadShortcuts();
    term.focus();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
