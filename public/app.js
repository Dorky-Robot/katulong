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
    import { createTokenStore, setNewToken, invalidateTokens } from "/lib/token-store.js";
    import { createTokenListComponent } from "/lib/token-list-component.js";
    import { createTokenFormManager } from "/lib/token-form.js";
    import { createShortcutsStore } from "/lib/shortcuts-store.js";
    import { createShortcutsPopup, createShortcutsEditPanel, createAddShortcutModal } from "/lib/shortcuts-components.js";
    import { createDictationModal } from "/lib/dictation-modal.js";
    import { createDragDropManager } from "/lib/drag-drop.js";
    import { showToast, isImageFile, uploadImage } from "/lib/image-upload.js";
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

    // --- Modal Manager ---
    const modals = new ModalRegistry();

    // Register modals (will be called after terminal is created)
    function initModals(terminal) {
      modals.register('shortcuts', 'shortcuts-overlay', {
        returnFocus: terminal,
        onClose: () => terminal.focus()
      });
      modals.register('edit', 'edit-overlay', {
        returnFocus: terminal,
        onClose: () => terminal.focus()
      });
      modals.register('add', 'add-modal', {
        returnFocus: terminal,
        onOpen: () => {
          // Focus the key composer input after modal opens
          const keyInput = document.getElementById("key-composer-input");
          if (keyInput) keyInput.focus();
        },
        onClose: () => terminal.focus()
      });
      modals.register('session', 'session-overlay', {
        returnFocus: terminal,
        onClose: () => terminal.focus()
      });
      modals.register('dictation', 'dictation-overlay', {
        returnFocus: terminal,
        onClose: () => terminal.focus()
      });
      modals.register('settings', 'settings-overlay', {
        returnFocus: terminal,
        onClose: () => terminal.focus()
      });
    }

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

    // P2P UI indicator (pure effect)
    function updateP2PIndicator() {
      const dot = document.getElementById("p2p-indicator");
      if (!dot) return;
      const p2pState = p2pManager.getState();
      dot.classList.toggle("p2p-active", p2pState.connected);
      dot.classList.toggle("p2p-relay", state.connection.attached && !p2pState.connected);
      dot.title = p2pState.connected ? "Connected (direct)"
        : state.connection.attached ? "Connected (relay)"
        : "Disconnected";
    }

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
    initModals(term);

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

    let sendBuf = "";
    let sendTimer = 0;
    function rawSend(data) {
      sendBuf += data;
      if (!sendTimer) {
        sendTimer = requestAnimationFrame(() => {
          sendTimer = 0;
          if (!sendBuf) return;
          const payload = JSON.stringify({ type: "input", data: sendBuf });
          // Try P2P first, fall back to WebSocket
          if (!p2pManager.send(payload)) {
            if (state.connection.ws?.readyState === 1) {
              state.connection.ws.send(payload);
            }
          }
          sendBuf = "";
        });
      }
    }

    // Initialize terminal keyboard handlers
    const terminalKeyboard = createTerminalKeyboard({
      term,
      onSend: rawSend
    });
    terminalKeyboard.init();

    // --- Pure WebSocket message handlers (functional core) ---
    const wsMessageHandlers = {
      attached: (msg, currentState) => ({
        stateUpdates: {
          'connection.attached': true,
          'scroll.userScrolledUpBeforeDisconnect': false
        },
        effects: [
          { type: 'updateP2PIndicator' },
          { type: 'initP2P' },
          { type: 'scrollToBottomIfNeeded', condition: !currentState.scroll.userScrolledUpBeforeDisconnect }
        ]
      }),

      output: (msg) => ({
        stateUpdates: {},
        effects: [
          { type: 'terminalWrite', data: msg.data, preserveScroll: true }
        ]
      }),

      'p2p-signal': (msg, currentState) => ({
        stateUpdates: {},
        effects: currentState.p2p.peer
          ? [{ type: 'p2pSignal', data: msg.data }]
          : []
      }),

      'p2p-ready': () => ({
        stateUpdates: {},
        effects: [
          { type: 'log', message: '[P2P] Server confirmed DataChannel ready' },
          { type: 'updateP2PIndicator' }
        ]
      }),

      'p2p-closed': () => ({
        stateUpdates: { 'p2p.connected': false },
        effects: [
          { type: 'log', message: '[P2P] Server reports DataChannel closed' },
          { type: 'updateP2PIndicator' }
        ]
      }),

      'pair-complete': (msg, currentState, wizardActivePairCode) => ({
        stateUpdates: {},
        effects: (wizardActivePairCode && msg.code === wizardActivePairCode)
          ? [{ type: 'stopWizardPairing' }, { type: 'switchSettingsView', view: 'success' }]
          : []
      }),

      reload: () => ({
        stateUpdates: {},
        effects: [{ type: 'reload' }]
      }),

      exit: () => ({
        stateUpdates: {},
        effects: [{ type: 'terminalWrite', data: '\r\n[shell exited]\r\n' }]
      }),

      'session-removed': () => ({
        stateUpdates: {},
        effects: [{ type: 'terminalWrite', data: '\r\n[session deleted]\r\n' }]
      }),

      'session-renamed': (msg) => ({
        stateUpdates: { 'session.name': msg.name },
        effects: [{ type: 'updateSessionUI', name: msg.name }]
      }),

      'credential-registered': () => ({
        stateUpdates: {},
        effects: [{ type: 'refreshTokensAfterRegistration' }]
      })
    };

    // Effect executor (side effects at edges)
    function executeEffect(effect) {
      switch (effect.type) {
        case 'updateP2PIndicator':
          updateP2PIndicator();
          break;
        case 'initP2P':
          p2pManager.create();
          break;
        case 'scrollToBottomIfNeeded':
          if (effect.condition) {
            scrollToBottom(term);
          }
          break;
        case 'terminalWrite':
          if (effect.preserveScroll) {
            terminalWriteWithScroll(term, effect.data);
          } else {
            term.write(effect.data);
          }
          break;
        case 'p2pSignal':
          p2pManager.signal(effect.data);
          break;
        case 'log':
          console.log(effect.message);
          break;
        case 'stopWizardPairing':
          stopWizardPairing();
          break;
        case 'switchSettingsView':
          switchSettingsView(effect.view === 'success' ? viewSuccess : null);
          break;
        case 'reload':
          location.reload();
          break;
        case 'updateSessionUI':
          document.title = effect.name;
          const url = new URL(window.location);
          url.searchParams.set("s", effect.name);
          history.replaceState(null, "", url);
          renderBar(effect.name);
          break;
        case 'refreshTokensAfterRegistration':
          // Refresh token list to show newly used token
          loadTokens();
          // Hide token creation form and show "Generate New Token" button
          const tokenCreateForm = document.getElementById("token-create-form");
          const createTokenBtn = document.getElementById("settings-create-token");
          if (tokenCreateForm) tokenCreateForm.style.display = "none";
          if (createTokenBtn) createTokenBtn.style.display = "block";
          break;
      }
    }

    let isConnecting = false;
    let reconnectTimeout = null;

    function connect() {
      // Prevent multiple simultaneous connection attempts
      if (isConnecting) {
        console.log('[WS] Already connecting, skipping duplicate attempt');
        return;
      }

      // Clear any pending reconnection timeout
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      isConnecting = true;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      state.connection.ws = new WebSocket(`${proto}//${location.host}`);

      state.connection.ws.onopen = () => {
        isConnecting = false;
        state.connection.reconnectDelay = 1000;
        state.connection.ws.send(JSON.stringify({ type: "attach", session: state.session.name, cols: term.cols, rows: term.rows }));
        state.connection.ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };

      state.connection.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const handler = wsMessageHandlers[msg.type];

        if (handler) {
          const { stateUpdates, effects } = handler(msg, state, wizardActivePairCode);

          // Apply state updates
          if (Object.keys(stateUpdates).length > 0) {
            state.updateMany(stateUpdates);
          }

          // Execute effects
          effects.forEach(executeEffect);
        }
      };

      state.connection.ws.onclose = (event) => {
        isConnecting = false;

        // Check if connection was closed due to revoked credentials
        if (event.code === 1008) { // 1008 = Policy Violation
          console.log('[Auth] Session invalidated, redirecting to login');
          // Redirect to login with message
          window.location.href = '/login?reason=revoked';
          return;
        }

        // Normal disconnect - attempt reconnection with exponential backoff
        const viewport = document.querySelector(".xterm-viewport");
        state.scroll.userScrolledUpBeforeDisconnect = !isAtBottom(viewport);
        state.connection.attached = false;
        p2pManager.destroy();

        console.log(`[WS] Reconnecting in ${state.connection.reconnectDelay}ms`);
        reconnectTimeout = setTimeout(connect, state.connection.reconnectDelay);
        state.connection.reconnectDelay = Math.min(state.connection.reconnectDelay * 2, 10000);
      };

      state.connection.ws.onerror = (err) => {
        console.log('[WS] Connection error:', err.message || 'Unknown error');
        isConnecting = false;
        state.connection.ws.close();
      };
    }

    // Force reconnect when returning to PWA after being backgrounded
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        // Coming back to foreground
        const hiddenDuration = Date.now() - hiddenAt;

        // Skip if already connecting
        if (isConnecting) {
          console.log('[Reconnect] Already connecting, skipping visibility reconnect');
          return;
        }

        // If was hidden for more than 5 seconds, force reconnect
        if (hiddenDuration > 5000 && state.connection.ws && !isConnecting) {
          console.log(`[Reconnect] Was hidden for ${Math.round(hiddenDuration/1000)}s, forcing reconnect`);
          state.connection.ws.close();
        } else if (state.connection.ws && state.connection.ws.readyState === WebSocket.OPEN) {
          // Quick test - send resize to verify connection is alive
          try {
            state.connection.ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          } catch (e) {
            console.log("[Reconnect] Send failed, forcing reconnect");
            state.connection.ws.close();
          }
        }
      }
    });

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


    // Focus terminal on tap
    termContainer.addEventListener("touchstart", () => term.focus(), { passive: true });

    // Long-press: native contextmenu event (fired by OS on long-press)
    termContainer.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openDictationModal();
    });

    const ro = new ResizeObserver(() => {
      withPreservedScroll(term, () => fit.fit());
      if (state.connection.ws?.readyState === 1) state.connection.ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    });
    ro.observe(termContainer);

    function resizeToViewport() {
      withPreservedScroll(term, () => {
        const vv = window.visualViewport;
        const h = vv ? vv.height : window.innerHeight;
        const top = vv ? vv.offsetTop : 0;
        bar.style.top = top + "px";
        termContainer.style.height = (h - 44) + "px";
        const s = document.documentElement.style;
        s.setProperty("--viewport-h", h + "px");
        s.setProperty("--viewport-top", top + "px");
      });
    }
    resizeToViewport();
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", resizeToViewport);
      window.visualViewport.addEventListener("scroll", resizeToViewport);
    }
    window.addEventListener("resize", resizeToViewport);

    const scrollBtn = document.getElementById("scroll-bottom");
    const viewport = document.querySelector(".xterm-viewport");
    if (viewport) {
      let scrollRaf = 0;
      viewport.addEventListener("scroll", () => {
        if (!scrollRaf) {
          scrollRaf = requestAnimationFrame(() => {
            scrollRaf = 0;
            const atBottom = viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 10;
            scrollBtn.style.display = atBottom ? "none" : "flex";
          });
        }
      }, { passive: true });
    }
    scrollBtn.addEventListener("click", () => { term.scrollToBottom(term); scrollBtn.style.display = "none"; });

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

    // Utility functions for wizard component
    let connectInfoCache = null;
    let qrLibLoaded = false;

    const loadQRLib = async () => {
      if (qrLibLoaded) return;
      if (typeof QRCode !== "undefined") {
        qrLibLoaded = true;
        return;
      }
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "/vendor/qrcode/qrcode.min.js";
        s.onload = () => {
          qrLibLoaded = true;
          resolve();
        };
        s.onerror = reject;
        document.head.appendChild(s);
      });
    };

    const getConnectInfo = async () => {
      if (connectInfoCache) return connectInfoCache;
      const res = await fetch("/connect/info");
      connectInfoCache = await res.json();
      return connectInfoCache;
    };

    async function checkPairingStatus(code) {
      try {
        const res = await fetch(`/auth/pair/status/${code}`);
        if (!res.ok) return false;
        const data = await res.json();
        return data.consumed;
      } catch {
        return false;
      }
    }

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
    // Upload function wrapper to send path to terminal
    async function uploadImageToTerminal(file) {
      try {
        const res = await fetch("/upload", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-Filename": file.name },
          body: file,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Upload failed" }));
          showToast(err.error || "Upload failed", true);
          return;
        }
        const { path } = await res.json();
        rawSend(path + " ");
      } catch {
        showToast("Upload failed", true);
      }
    }

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

    // --- Boot ---

    renderBar(state.session.name);  // Initial render
    connect();
    loadShortcuts();
    term.focus();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
