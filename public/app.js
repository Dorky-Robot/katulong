    import { Terminal } from "/vendor/xterm/xterm.esm.js";
    import { FitAddon } from "/vendor/xterm/addon-fit.esm.js";
    import { WebLinksAddon } from "/vendor/xterm/addon-web-links.esm.js";
    import { getOrCreateDeviceId, generateDeviceName } from "/lib/device.js";
    import { ModalRegistry } from "/lib/modal.js";
    import { ListRenderer } from "/lib/list-renderer.js";
    import { createStore, createReducer } from "/lib/store.js";
    import { createWizardStore, WIZARD_STATES, WIZARD_ACTIONS } from "/lib/wizard-state.js";
    import { createDeviceStore, loadDevices as reloadDevices, invalidateDevices } from "/lib/device-store.js";
    import { createDeviceListComponent } from "/lib/device-list-component.js";
    import { createWizardComponent } from "/lib/wizard-component.js";

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

    // --- CSRF Protection ---

    function getCsrfToken() {
      const meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.content : null;
    }

    function addCsrfHeader(headers = {}) {
      const token = getCsrfToken();
      if (token) {
        headers['X-CSRF-Token'] = token;
      }
      return headers;
    }

    // --- Theme ---

    const DARK_THEME = {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
      selectionBackground: "rgba(137,180,250,0.3)",
      black: "#45475a", brightBlack: "#585b70",
      red: "#f38ba8", brightRed: "#f38ba8",
      green: "#a6e3a1", brightGreen: "#a6e3a1",
      yellow: "#f9e2af", brightYellow: "#f9e2af",
      blue: "#89b4fa", brightBlue: "#89b4fa",
      magenta: "#f5c2e7", brightMagenta: "#f5c2e7",
      cyan: "#94e2d5", brightCyan: "#94e2d5",
      white: "#bac2de", brightWhite: "#a6adc8",
    };
    const LIGHT_THEME = {
      background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78",
      selectionBackground: "rgba(30,102,245,0.2)",
      black: "#5c5f77", brightBlack: "#6c6f85",
      red: "#d20f39", brightRed: "#d20f39",
      green: "#40a02b", brightGreen: "#40a02b",
      yellow: "#df8e1d", brightYellow: "#df8e1d",
      blue: "#1e66f5", brightBlue: "#1e66f5",
      magenta: "#ea76cb", brightMagenta: "#ea76cb",
      cyan: "#179299", brightCyan: "#179299",
      white: "#acb0be", brightWhite: "#bcc0cc",
    };

    // --- Scroll state management (composable effects) ---

    // Pure: Check if viewport is at bottom
    function isAtBottom(viewport = document.querySelector(".xterm-viewport")) {
      if (!viewport) return true;
      // Dynamic threshold: 10px minimum or 2% of viewport height (better for high-DPI)
      const threshold = Math.max(10, viewport.clientHeight * 0.02);
      return viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - threshold;
    }

    // Effect: Scroll to bottom with double RAF for layout settling
    const scrollToBottom = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => term.scrollToBottom());
      });
    };

    // Composable: Preserve scroll position during operation
    const withPreservedScroll = (operation) => {
      const viewport = document.querySelector(".xterm-viewport");
      const wasAtBottom = isAtBottom(viewport);
      operation();
      if (wasAtBottom) scrollToBottom();
    };

    // Composable: Terminal write with preserved scroll
    const terminalWriteWithScroll = (data, onComplete) => {
      const viewport = document.querySelector(".xterm-viewport");
      const wasAtBottom = isAtBottom(viewport);
      term.write(data, () => {
        if (wasAtBottom) scrollToBottom();
        if (onComplete) onComplete();
      });
    };

    function getEffectiveTheme() {
      const pref = localStorage.getItem("theme") || "auto";
      return pref === "auto"
        ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
        : pref;
    }

    function applyTheme(pref) {
      localStorage.setItem("theme", pref);
      document.documentElement.setAttribute("data-theme", pref);
      const effective = getEffectiveTheme();

      withPreservedScroll(() => {
        term.options.theme = effective === "light" ? LIGHT_THEME : DARK_THEME;
      });

      const metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) metaTheme.content = effective === "light" ? "#eff1f5" : "#1e1e2e";
      document.querySelectorAll(".theme-toggle button").forEach(btn => {
        const active = btn.dataset.themeVal === pref;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-checked", active);
      });
    }

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

    // --- Shortcuts state management (centralized store) ---
    const shortcutsReducer = createReducer([], {
      'LOAD': (shortcuts, action) => {
        return Array.isArray(action.items) ? action.items.filter(s => s.label && s.keys) : [];
      },
      'ADD': (shortcuts, action) => {
        return [...shortcuts, action.item];
      },
      'REMOVE': (shortcuts, action) => {
        return shortcuts.filter((_, idx) => idx !== action.index);
      }
    });

    // Create store for shortcuts
    const shortcutsStore = createStore([], shortcutsReducer, { debug: false });

    // Subscribe to shortcuts changes for render side effects
    shortcutsStore.subscribe((shortcuts, action) => {
      // Update legacy state object (for backward compatibility)
      state.update('session.shortcuts', shortcuts);

      // Render effects
      renderBar(state.session.name);
      if (action.type === 'REMOVE' || action.type === 'ADD') {
        renderEditList(shortcuts);
      }
    });

    // Convenience wrapper (maintains same API)
    const dispatchShortcuts = (action) => shortcutsStore.dispatch(action);

    // --- P2P Manager (edge module) ---
    const createP2PManager = (config) => {
      let peer = null;
      let connected = false;
      let retryTimer = 0;
      const RETRY_MS = 3000;

      const { onStateChange, onData, getWS } = config;

      const destroy = () => {
        clearTimeout(retryTimer);
        retryTimer = 0;
        if (peer) {
          try { peer.destroy(); } catch {}
          peer = null;
        }
        if (connected) {
          connected = false;
          onStateChange({ connected: false, peer: null });
        }
      };

      const scheduleRetry = () => {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          const ws = getWS();
          if (!connected && state.connection.ws?.readyState === 1) {
            create();
          }
        }, RETRY_MS);
      };

      const create = () => {
        if (typeof SimplePeer === "undefined") return;
        destroy();

        const ws = getWS();
        const newPeer = new SimplePeer({ initiator: true, trickle: true, config: { iceServers: [] } });

        newPeer.on("signal", (data) => {
          if (state.connection.ws?.readyState === 1) {
            state.connection.ws.send(JSON.stringify({ type: "p2p-signal", data }));
          }
        });

        newPeer.on("connect", () => {
          connected = true;
          console.log("[P2P] DataChannel connected");
          onStateChange({ connected: true, peer: newPeer });
        });

        newPeer.on("data", (chunk) => {
          const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          onData(str);
        });

        newPeer.on("close", () => {
          console.log("[P2P] DataChannel closed, using WS");
          connected = false;
          peer = null;
          onStateChange({ connected: false, peer: null });
          scheduleRetry();
        });

        newPeer.on("error", (err) => {
          console.warn("[P2P] error:", err.message);
          connected = false;
          peer = null;
          onStateChange({ connected: false, peer: null });
          scheduleRetry();
        });

        peer = newPeer;
        onStateChange({ connected: false, peer: newPeer });
      };

      const signal = (data) => {
        if (peer) peer.signal(data);
      };

      const send = (data) => {
        if (!connected || !peer) return false;
        try {
          peer.send(data);
          return true;
        } catch {
          return false;
        }
      };

      const getState = () => ({ connected, peer });

      return { create, destroy, signal, send, getState, scheduleRetry };
    };

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
            terminalWriteWithScroll(msg.data);
          }
        } catch {
          terminalWriteWithScroll(str);
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
      theme: getEffectiveTheme() === "light" ? LIGHT_THEME : DARK_THEME,
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
      withPreservedScroll(() => fit.fit());
      // Ensure we start at bottom on initial page load
      scrollToBottom();
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

    // Intercept Tab at document level (capture phase) to prevent browser
    // focus navigation and send \t to the PTY.
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Tab" || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      const active = document.activeElement;
      const inTerminal = active && (
        active.classList.contains("xterm-helper-textarea") ||
        active.closest("#terminal-container")
      );
      if (!inTerminal) return;
      ev.preventDefault();
      ev.stopPropagation();
      rawSend(ev.shiftKey ? "\x1b[Z" : "\t");
    }, true);

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.metaKey && ev.key === "c" && term.hasSelection()) return false;
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "v") return false;
      if (ev.ctrlKey && ev.key === "c" && !term.hasSelection()) return true;

      // Tab handled by capture-phase listener above
      if (ev.key === "Tab") return false;

      // Shift+Enter: quoted-insert (\x16) + newline (\x0a) — inserts a literal
      // newline without executing, works in zsh/bash with no shell config needed
      if (ev.shiftKey && ev.key === "Enter" && ev.type === "keydown") {
        rawSend("\x16\x0a");
        return false;
      }

      if (ev.metaKey && ev.type === "keydown") {
        if (ev.key === "k") { term.clear(); return false; }
        const seq = { Backspace: "\x15", ArrowLeft: "\x01", ArrowRight: "\x05" }[ev.key];
        if (seq) { rawSend(seq); return false; }
      }
      if (ev.altKey && ev.type === "keydown") {
        const seq = { Backspace: "\x1b\x7f", ArrowLeft: "\x1bb", ArrowRight: "\x1bf" }[ev.key];
        if (seq) { rawSend(seq); return false; }
      }
      return true;
    });

    term.onData((data) => {
      // Filter focus-reporting sequences (CSI I / CSI O) that xterm.js
      // emits when the browser tab gains/loses focus. These leak into
      // CLI apps like Claude Code as garbage input (issue #10375).
      const filtered = data.replace(/\x1b\[I/g, "").replace(/\x1b\[O/g, "");
      if (filtered) rawSend(filtered);
    });

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
            scrollToBottom();
          }
          break;
        case 'terminalWrite':
          if (effect.preserveScroll) {
            terminalWriteWithScroll(effect.data);
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

    // --- Joystick: hold left/right, flick up/down, long-press center for Enter ---
    // --- Joystick state machine ---
    const joystick = document.getElementById("joystick");
    const enterRing = document.getElementById("enter-progress-ring");
    const enterCircle = enterRing.querySelector("circle");

    const ARROWS = {
      up: "\x1b[A",
      down: "\x1b[B",
      right: "\x1b[C",
      left: "\x1b[D",
    };

    const JOYSTICK_CONFIG = {
      CENTER_THRESHOLD: 0.4,
      LONG_PRESS_DURATION: 600,
      RING_CIRCUMFERENCE: 2 * Math.PI * 36,
      MOVEMENT_THRESHOLD: 10,
      REPEAT_INTERVAL: 50
    };

    // Pure: Determine zone from touch position
    const getZone = (touch, rect) => {
      const x = touch.clientX - rect.left - rect.width / 2;
      const y = touch.clientY - rect.top - rect.height / 2;
      const distance = Math.sqrt(x * x + y * y);
      const radius = Math.min(rect.width, rect.height) / 2;

      if (distance < radius * JOYSTICK_CONFIG.CENTER_THRESHOLD) {
        return 'center';
      }

      return Math.abs(x) > Math.abs(y)
        ? (x > 0 ? 'right' : 'left')
        : (y > 0 ? 'down' : 'up');
    };

    // Joystick state reducer
    const joystickReducer = (state, action) => {
      switch (action.type) {
        case 'TOUCH_START':
          return {
            mode: action.zone === 'center' ? 'long-press'
              : (action.zone === 'left' || action.zone === 'right') ? 'hold'
              : 'flick-wait',
            zone: action.zone,
            startX: action.x,
            startY: action.y,
            hasMoved: false,
            enterSent: false
          };

        case 'TOUCH_MOVE':
          const moved = Math.sqrt(action.dx * action.dx + action.dy * action.dy) > JOYSTICK_CONFIG.MOVEMENT_THRESHOLD;
          return {
            ...state,
            hasMoved: state.hasMoved || moved,
            zone: action.newZone || state.zone
          };

        case 'TOUCH_END':
          return {
            mode: 'idle',
            zone: null,
            startX: 0,
            startY: 0,
            hasMoved: false,
            enterSent: false
          };

        case 'LONG_PRESS_COMPLETE':
          return { ...state, enterSent: true };

        case 'TOUCH_CANCEL':
          return {
            mode: 'idle',
            zone: null,
            startX: 0,
            startY: 0,
            hasMoved: false,
            enterSent: false
          };

        default:
          return state;
      }
    };

    // Joystick effects (side effects at edges)
    const joystickEffects = {
      showRing: () => {
        enterRing.classList.add("active");
        enterCircle.style.strokeDasharray = JOYSTICK_CONFIG.RING_CIRCUMFERENCE;
        enterCircle.style.strokeDashoffset = JOYSTICK_CONFIG.RING_CIRCUMFERENCE;
        enterCircle.style.transition = `stroke-dashoffset ${JOYSTICK_CONFIG.LONG_PRESS_DURATION}ms linear`;
        requestAnimationFrame(() => {
          enterCircle.style.strokeDashoffset = 0;
        });
      },

      hideRing: () => {
        enterRing.classList.remove("active");
        enterCircle.style.transition = "none";
        enterCircle.style.strokeDashoffset = JOYSTICK_CONFIG.RING_CIRCUMFERENCE;
      },

      sendSequence: (sequence) => {
        rawSend(sequence);
        joystickEffects.showFeedback();
      },

      showFeedback: () => {
        const rect = joystick.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const el = document.createElement("div");
        el.className = "swipe-feedback";
        el.style.left = x + "px";
        el.style.top = y + "px";
        document.body.appendChild(el);
        el.addEventListener("animationend", () => el.remove(), { once: true });
      }
    };

    // Joystick manager (stateful edge module)
    const createJoystickManager = () => {
      let joyState = {
        mode: 'idle',
        zone: null,
        startX: 0,
        startY: 0,
        hasMoved: false,
        enterSent: false
      };

      let repeatTimer = null;
      let longPressTimer = null;

      const dispatch = (action) => {
        const prevState = joyState;
        joyState = joystickReducer(joyState, action);

        // Handle side effects based on state transitions
        if (prevState.mode !== joyState.mode) {
          if (joyState.mode === 'long-press') {
            joystickEffects.showRing();
            longPressTimer = setTimeout(() => {
              if (!joyState.hasMoved) {
                joystickEffects.sendSequence("\r");
                dispatch({ type: 'LONG_PRESS_COMPLETE' });
                joystickEffects.hideRing();
              }
            }, JOYSTICK_CONFIG.LONG_PRESS_DURATION);
          } else if (joyState.mode === 'hold' && (joyState.zone === 'left' || joyState.zone === 'right')) {
            const seq = ARROWS[joyState.zone];
            joystickEffects.sendSequence(seq);
            repeatTimer = setInterval(() => {
              rawSend(seq);
            }, JOYSTICK_CONFIG.REPEAT_INTERVAL);
          } else if (joyState.mode === 'idle' || joyState.mode === 'flick-wait') {
            if (repeatTimer) {
              clearInterval(repeatTimer);
              repeatTimer = null;
            }
            if (longPressTimer) {
              clearTimeout(longPressTimer);
              longPressTimer = null;
            }
            joystickEffects.hideRing();
          }
        }

        // Handle zone changes in hold mode
        if (joyState.mode === 'hold' && prevState.zone !== joyState.zone && (joyState.zone === 'left' || joyState.zone === 'right')) {
          if (repeatTimer) {
            clearInterval(repeatTimer);
          }
          const seq = ARROWS[joyState.zone];
          joystickEffects.sendSequence(seq);
          repeatTimer = setInterval(() => {
            rawSend(seq);
          }, JOYSTICK_CONFIG.REPEAT_INTERVAL);
        }

        // Handle movement canceling long-press
        if (joyState.mode === 'long-press' && joyState.hasMoved && !prevState.hasMoved) {
          if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
          joystickEffects.hideRing();
        }
      };

      return { dispatch, getState: () => joyState };
    };

    const joyManager = createJoystickManager();

    joystick.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const t = e.touches[0];
      const rect = joystick.getBoundingClientRect();
      const zone = getZone(t, rect);
      joyManager.dispatch({ type: 'TOUCH_START', zone, x: t.clientX, y: t.clientY });
    });

    joystick.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const t = e.touches[0];
      const state = joyManager.getState();
      const dx = t.clientX - state.startX;
      const dy = t.clientY - state.startY;
      const rect = joystick.getBoundingClientRect();
      const newZone = (state.mode === 'hold') ? getZone(t, rect) : null;
      joyManager.dispatch({ type: 'TOUCH_MOVE', dx, dy, newZone });
    });

    joystick.addEventListener("touchend", (e) => {
      e.preventDefault();
      const state = joyManager.getState();

      if (!state.enterSent && state.mode === 'flick-wait') {
        const t = e.changedTouches[0];
        const dx = t.clientX - state.startX;
        const dy = t.clientY - state.startY;
        const moved = Math.max(Math.abs(dx), Math.abs(dy));

        if (moved >= JOYSTICK_CONFIG.MOVEMENT_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
          const seq = dy > 0 ? ARROWS.down : ARROWS.up;
          joystickEffects.sendSequence(seq);
        }
      }

      joyManager.dispatch({ type: 'TOUCH_END' });
    });

    joystick.addEventListener("touchcancel", (e) => {
      e.preventDefault();
      joyManager.dispatch({ type: 'TOUCH_CANCEL' });
    });

    // --- Pull-up to refresh (force reconnect) ---
    {
      const indicator = document.getElementById("pull-refresh-indicator");
      let pullStartY = 0;
      let isPulling = false;
      const PULL_THRESHOLD = 80; // pixels to pull before triggering

      termContainer.addEventListener("touchstart", (e) => {
        const viewport = document.querySelector(".xterm-viewport");
        // Only allow pull-up if at bottom of scrollback
        if (isAtBottom(viewport)) {
          pullStartY = e.touches[0].clientY;
          isPulling = false;
        }
      });

      termContainer.addEventListener("touchmove", (e) => {
        if (pullStartY === 0) return;

        const currentY = e.touches[0].clientY;
        const pullDistance = pullStartY - currentY; // Negative = pulling down, Positive = pulling up

        if (pullDistance > 20) {
          isPulling = true;
          const progress = Math.min(pullDistance / PULL_THRESHOLD, 1);
          indicator.style.transform = `translateX(-50%) translateY(${100 - progress * 100}%)`;
          indicator.classList.add("visible");
        } else {
          indicator.classList.remove("visible");
          indicator.style.transform = "translateX(-50%) translateY(100%)";
        }
      });

      termContainer.addEventListener("touchend", (e) => {
        if (isPulling && pullStartY > 0) {
          const lastY = e.changedTouches[0].clientY;
          const pullDistance = pullStartY - lastY;

          if (pullDistance >= PULL_THRESHOLD) {
            // If connected, send Ctrl-L to refresh. If disconnected, reconnect.
            if (state.connection.ws && state.connection.ws.readyState === WebSocket.OPEN && state.connection.attached) {
              console.log("[Pull-refresh] Connected - sending Ctrl-L");
              rawSend("\x0C"); // Ctrl-L: refresh screen
            } else {
              console.log("[Pull-refresh] Disconnected - forcing reconnect");
              if (state.connection.ws) state.connection.ws.close();
            }
          }
        }

        // Reset
        pullStartY = 0;
        isPulling = false;
        indicator.classList.remove("visible");
        indicator.style.transform = "translateX(-50%) translateY(100%)";
      });

      termContainer.addEventListener("touchcancel", () => {
        pullStartY = 0;
        isPulling = false;
        indicator.classList.remove("visible");
        indicator.style.transform = "translateX(-50%) translateY(100%)";
      });
    }

    // Focus terminal on tap
    termContainer.addEventListener("touchstart", () => term.focus(), { passive: true });

    // Long-press: native contextmenu event (fired by OS on long-press)
    termContainer.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openDictationModal();
    });

    const ro = new ResizeObserver(() => {
      withPreservedScroll(() => fit.fit());
      if (state.connection.ws?.readyState === 1) state.connection.ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    });
    ro.observe(termContainer);

    function resizeToViewport() {
      withPreservedScroll(() => {
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
    scrollBtn.addEventListener("click", () => { term.scrollToBottom(); scrollBtn.style.display = "none"; });

    // --- Pure: key sequence mapping ---

    function singleComboToSequence(combo) {
      const parts = combo.toLowerCase().trim().split("+");
      const mods = new Set();
      let base = null;

      for (const p of parts) {
        if (["ctrl", "cmd", "alt", "shift"].includes(p)) mods.add(p);
        else base = p;
      }

      const named = {
        esc: "\x1b", tab: "\t", enter: "\r", space: " ",
        backspace: "\x7f", delete: "\x1b[3~",
        up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
      };

      if (!base && mods.size > 0) return "";
      if (mods.has("ctrl") && base?.length === 1 && base >= "a" && base <= "z")
        return String.fromCharCode(base.charCodeAt(0) - 96);
      if (mods.has("ctrl")) { const m = { backspace: "\x08", space: "\x00" }; if (m[base]) return m[base]; }
      if (mods.has("cmd"))  { const m = { backspace: "\x15", left: "\x01", right: "\x05", k: "\x0b" }; if (m[base]) return m[base]; }
      if (mods.has("alt"))  {
        const m = { backspace: "\x1b\x7f", left: "\x1bb", right: "\x1bf" };
        if (m[base]) return m[base];
        if (base?.length === 1) return "\x1b" + base;
      }
      if (mods.has("shift") && base?.length === 1) return base.toUpperCase();
      if (named[base]) return named[base];
      if (base?.length === 1) return base;
      return combo;
    }

    function keysToSequence(keys) {
      return keys.split(",").map(part => singleComboToSequence(part.trim()));
    }

    function sendSequence(parts) {
      if (typeof parts === "string") { rawSend(parts); return; }
      parts.forEach((p, i) => {
        if (i === 0) rawSend(p);
        else setTimeout(() => rawSend(p), i * 100);
      });
    }

    // --- Key transformation pipeline (composable) ---

    // Pure: Composition helper
    const pipe = (...fns) => (x) => fns.reduce((v, f) => f(v), x);

    // Pure: Group keys by comma separator
    const groupKeysBySeparator = (keys) => {
      const groups = [];
      let current = [];
      for (const k of keys) {
        if (k === ",") {
          if (current.length > 0) groups.push(current);
          current = [];
        } else {
          current.push(k);
        }
      }
      if (current.length > 0) groups.push(current);
      return groups;
    };

    // Pure: Transform groups with mapper function
    const mapGroups = (groupMapper) => (groups) => groups.map(groupMapper);

    // Pure: Join groups with separators
    const joinGroups = (innerSep, outerSep) => (groups) =>
      groups.map(g => g.join(innerSep)).join(outerSep);

    // Pure: Key display mapping
    const KEY_DISPLAY = {
      ctrl: "Ctrl", cmd: "Cmd", alt: "Alt", option: "Option", shift: "Shift",
      esc: "Esc", escape: "Esc", tab: "Tab", enter: "Enter", return: "Enter",
      space: "Space", backspace: "Bksp", delete: "Del",
      up: "Up", down: "Down", left: "Left", right: "Right",
    };

    const displayKey = (k) => KEY_DISPLAY[k] || k.toUpperCase();

    // Composable pipelines
    const keysLabel = pipe(
      groupKeysBySeparator,
      mapGroups(group => group.map(displayKey)),
      joinGroups("+", ", ")
    );

    const keysString = pipe(
      groupKeysBySeparator,
      joinGroups("+", ",")
    );

    const VALID_KEYS = new Set([
      "ctrl", "cmd", "alt", "option", "shift",
      ..."abcdefghijklmnopqrstuvwxyz".split(""),
      ..."0123456789".split(""),
      "esc", "escape", "tab", "enter", "return", "space", "backspace", "delete",
      "up", "down", "left", "right",
      "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
      ",",
    ]);

    function normalizeKey(val) {
      const aliases = { option: "alt", escape: "esc", return: "enter" };
      return aliases[val] || val;
    }

    // --- Shortcut bar (render takes data) ---

    const pinnedKeys = [
      { label: "Esc", keys: "esc" },
      { label: "Tab", keys: "tab" },
    ];

    function renderBar(name) {
      bar.innerHTML = "";

      const p2pDot = document.createElement("span");
      p2pDot.id = "p2p-indicator";
      p2pDot.title = "P2P: connecting...";
      bar.appendChild(p2pDot);
      updateP2PIndicator();

      const sessBtn = document.createElement("button");
      sessBtn.className = "session-btn";
      sessBtn.tabIndex = -1;
      sessBtn.setAttribute("aria-label", `Session: ${name}`);
      sessBtn.innerHTML = '<i class="ph ph-terminal-window"></i> ';
      sessBtn.appendChild(document.createTextNode(name));
      sessBtn.addEventListener("click", openSessionManager);
      bar.appendChild(sessBtn);

      const spacer = document.createElement("span");
      spacer.className = "bar-spacer";
      bar.appendChild(spacer);

      for (const s of pinnedKeys) {
        const btn = document.createElement("button");
        btn.className = "shortcut-btn";
        btn.tabIndex = -1;
        btn.textContent = s.label;
        btn.setAttribute("aria-label", `Send ${s.label}`);
        btn.addEventListener("click", () => { sendSequence(keysToSequence(s.keys)); term.focus(); });
        bar.appendChild(btn);
      }

      const kbBtn = document.createElement("button");
      kbBtn.className = "bar-icon-btn";
      kbBtn.tabIndex = -1;
      kbBtn.setAttribute("aria-label", "Open shortcuts");
      kbBtn.innerHTML = '<i class="ph ph-keyboard"></i>';
      kbBtn.addEventListener("click", () => openShortcutsPopup(state.session.shortcuts));
      bar.appendChild(kbBtn);

      const setBtn = document.createElement("button");
      setBtn.className = "bar-icon-btn";
      setBtn.tabIndex = -1;
      setBtn.setAttribute("aria-label", "Settings");
      setBtn.innerHTML = '<i class="ph ph-gear"></i>';
      setBtn.addEventListener("click", () => modals.open('settings'));
      bar.appendChild(setBtn);
    }

    // --- Shortcuts popup (render takes data) ---

    const shortcutsOverlay = document.getElementById("shortcuts-overlay");
    const shortcutsGrid = document.getElementById("shortcuts-grid");

    function openShortcutsPopup(items) {
      shortcutsGrid.innerHTML = "";
      for (const s of items) {
        const btn = document.createElement("button");
        btn.className = "shortcut-btn";
        btn.setAttribute("role", "listitem");
        btn.textContent = s.label;
        btn.addEventListener("click", () => {
          sendSequence(keysToSequence(s.keys));
          modals.close('shortcuts');
        });
        shortcutsGrid.appendChild(btn);
      }
      modals.open('shortcuts');
    }

    document.getElementById("shortcuts-edit-btn").addEventListener("click", () => {
      modals.close('shortcuts');
      openEditPanel();
    });
    

    // --- Edit shortcuts (render takes data) ---

    const editOverlay = document.getElementById("edit-overlay");
    const editList = document.getElementById("edit-list");

    function renderEditList(items) {
      editList.innerHTML = "";
      items.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "edit-item";
        row.setAttribute("role", "listitem");
        const labelSpan = document.createElement("span");
        labelSpan.className = "edit-item-label";
        labelSpan.textContent = s.label;
        row.appendChild(labelSpan);
        const keysSpan = document.createElement("span");
        keysSpan.className = "edit-item-keys";
        keysSpan.textContent = s.keys;
        row.appendChild(keysSpan);
        const rm = document.createElement("button");
        rm.className = "edit-item-remove";
        rm.setAttribute("aria-label", `Remove ${s.label}`);
        rm.innerHTML = '<i class="ph ph-x"></i>';
        rm.addEventListener("click", () => {
          dispatchShortcuts({ type: 'REMOVE', index: i });
        });
        row.appendChild(rm);
        editList.appendChild(row);
      });
    }

    function openEditPanel() {
      renderEditList(state.session.shortcuts);
      modals.open('edit');
    }

    function closeEditPanel() {
      modals.close('edit');
      saveShortcuts();
    }

    document.getElementById("edit-done").addEventListener("click", closeEditPanel);
    document.getElementById("edit-add").addEventListener("click", openAddModal);
    

    async function loadShortcuts() {
      try {
        const res = await fetch("/shortcuts");
        const data = await res.json();
        dispatchShortcuts({ type: 'LOAD', items: data });
      } catch {
        dispatchShortcuts({ type: 'LOAD', items: [] });
      }
    }

    async function saveShortcuts() {
      try {
        await fetch("/shortcuts", {
          method: "PUT",
          headers: addCsrfHeader({ "Content-Type": "application/json" }),
          body: JSON.stringify(state.session.shortcuts),
        });
      } catch { /* ignore */ }
    }

    // --- Add shortcut modal (render takes data) ---

    const addOverlay = document.getElementById("add-modal-overlay");
    const keyComposer = document.getElementById("key-composer");
    const keyInput = document.getElementById("key-composer-input");
    const keyPreview = document.getElementById("key-preview-value");
    const saveBtn = document.getElementById("modal-save");

    // Local UI state for key composition
    let composedKeys = [];

    function renderComposerTags(keys) {
      keyComposer.querySelectorAll(".key-tag, .key-comma").forEach(t => t.remove());
      keys.forEach((k, i) => {
        if (k === ",") {
          const sep = document.createElement("span");
          sep.className = "key-comma";
          sep.textContent = ",";
          sep.addEventListener("click", () => {
            composedKeys = composedKeys.filter((_, idx) => idx !== i);
            renderComposerTags(composedKeys);
          });
          keyComposer.insertBefore(sep, keyInput);
          return;
        }
        const tag = document.createElement("span");
        tag.className = "key-tag";
        tag.appendChild(document.createTextNode(displayKey(k)));
        const rmBtn = document.createElement("button");
        rmBtn.className = "key-tag-remove";
        rmBtn.setAttribute("aria-label", `Remove ${displayKey(k)}`);
        rmBtn.innerHTML = '<i class="ph ph-x"></i>';
        tag.appendChild(rmBtn);
        rmBtn.addEventListener("click", () => {
          composedKeys = composedKeys.filter((_, idx) => idx !== i);
          renderComposerTags(composedKeys);
        });
        keyComposer.insertBefore(tag, keyInput);
      });
      keyPreview.textContent = keys.length > 0 ? keysLabel(keys) : "";
      saveBtn.disabled = keys.length === 0;
      keyInput.placeholder = keys.length ? "" : "type a key...";
    }

    function openAddModal() {
      composedKeys = [];
      keyInput.value = "";
      renderComposerTags(composedKeys);
      modals.open('add');
      // Focus is handled by modal's onOpen callback
    }

    keyComposer.addEventListener("click", () => keyInput.focus());

    keyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = keyInput.value.trim().toLowerCase();
        if (!val) return;
        if (VALID_KEYS.has(val)) {
          composedKeys = [...composedKeys, normalizeKey(val)];
          keyInput.value = "";
          renderComposerTags(composedKeys);
        } else {
          keyComposer.classList.add("invalid");
          setTimeout(() => keyComposer.classList.remove("invalid"), 350);
        }
      } else if (e.key === "Backspace" && keyInput.value === "" && composedKeys.length > 0) {
        composedKeys = composedKeys.slice(0, -1);
        renderComposerTags(composedKeys);
      }
    });

    document.getElementById("modal-cancel").addEventListener("click", () => modals.close('add'));

    document.getElementById("modal-save").addEventListener("click", () => {
      if (composedKeys.length === 0) return;
      dispatchShortcuts({ type: 'ADD', item: { label: keysLabel(composedKeys), keys: keysString(composedKeys) } });
      modals.close('add');
    });

    

    // --- Session manager (render takes data) ---

    const sessionOverlay = document.getElementById("session-overlay");
    const sessionListEl = document.getElementById("session-list");
    const sessionNewName = document.getElementById("session-new-name");

    async function openSessionManager() {
      modals.open('session');
      await renderSessionList(state.session.name);
      // Fetch and populate SSH password
      try {
        const res = await fetch("/ssh/password");
        if (res.ok) {
          const { password } = await res.json();
          const pwInput = document.getElementById("ssh-password-value");
          pwInput.value = password;
        }
      } catch { /* ignore */ }
    }

    // SSH password reveal toggle
    document.getElementById("ssh-password-reveal").addEventListener("click", () => {
      const pwInput = document.getElementById("ssh-password-value");
      const icon = document.querySelector("#ssh-password-reveal i");
      if (pwInput.type === "password") {
        pwInput.type = "text";
        icon.className = "ph ph-eye-slash";
      } else {
        pwInput.type = "password";
        icon.className = "ph ph-eye";
      }
    });

    // SSH password copy
    document.getElementById("ssh-password-copy").addEventListener("click", async () => {
      const pwInput = document.getElementById("ssh-password-value");
      const btn = document.getElementById("ssh-password-copy");
      try {
        await navigator.clipboard.writeText(pwInput.value);
        btn.innerHTML = '<i class="ph ph-check"></i>';
        btn.style.color = "var(--success)";
        setTimeout(() => { btn.innerHTML = '<i class="ph ph-copy"></i>'; btn.style.color = ""; }, 1500);
      } catch { /* clipboard not available */ }
    });

    async function renderSessionList(currentSession) {
      let sessions = [];
      let sshInfo = { sshPort: 2222, sshHost: "localhost" };
      try {
        const [sessRes, infoRes] = await Promise.all([fetch("/sessions"), fetch("/connect/info")]);
        sessions = await sessRes.json();
        if (infoRes.ok) Object.assign(sshInfo, await infoRes.json());
      } catch { /* ignore */ }

      sessionListEl.innerHTML = "";
      for (const s of sessions) {
        const row = document.createElement("div");
        row.className = "session-item";
        row.setAttribute("role", "listitem");

        const dot = document.createElement("span");
        dot.className = `session-status ${s.alive ? "alive" : "dead"}`;
        dot.setAttribute("aria-label", s.alive ? "Running" : "Exited");
        row.appendChild(dot);

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "session-name-input";
        nameInput.value = s.name;
        nameInput.setAttribute("aria-label", `Session name: ${s.name}`);
        nameInput.setAttribute("autocorrect", "off");
        nameInput.setAttribute("autocapitalize", "off");
        nameInput.setAttribute("spellcheck", "false");
        const originalName = s.name;

        async function commitRename() {
          const newName = nameInput.value.trim();
          if (!newName || newName === originalName) { nameInput.value = originalName; return; }
          try {
            const res = await fetch(`/sessions/${encodeURIComponent(originalName)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: newName }),
            });
            if (!res.ok) { nameInput.value = originalName; return; }
          } catch { nameInput.value = originalName; return; }
          await renderSessionList(currentSession);
        }

        nameInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); }
          if (e.key === "Escape") { nameInput.value = originalName; nameInput.blur(); }
        });
        nameInput.addEventListener("blur", commitRename);
        row.appendChild(nameInput);

        if (s.name === currentSession) {
          const cur = document.createElement("span");
          cur.className = "session-current-tag";
          cur.textContent = "(current)";
          row.appendChild(cur);
        } else {
          const openBtn = document.createElement("button");
          openBtn.className = "session-icon-btn open";
          openBtn.setAttribute("aria-label", `Switch to ${s.name}`);
          openBtn.innerHTML = '<i class="ph ph-arrow-right"></i>';
          openBtn.addEventListener("click", () => { location.href = `/?s=${encodeURIComponent(s.name)}`; });
          row.appendChild(openBtn);
        }

        const sshBtn = document.createElement("button");
        sshBtn.className = "session-icon-btn ssh";
        sshBtn.setAttribute("aria-label", `Copy SSH command for ${s.name}`);
        sshBtn.innerHTML = '<i class="ph ph-terminal"></i>';
        sshBtn.addEventListener("click", async () => {
          const cmd = `ssh ${s.name}@${sshInfo.sshHost} -p ${sshInfo.sshPort}`;
          try {
            await navigator.clipboard.writeText(cmd);
            sshBtn.innerHTML = '<i class="ph ph-check"></i>';
            sshBtn.style.color = "var(--success)";
            setTimeout(() => { sshBtn.innerHTML = '<i class="ph ph-terminal"></i>'; sshBtn.style.color = ""; }, 1500);
          } catch { /* clipboard not available */ }
        });
        row.appendChild(sshBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "session-icon-btn delete";
        delBtn.setAttribute("aria-label", `Delete session ${s.name}`);
        delBtn.innerHTML = '<i class="ph ph-trash"></i>';
        delBtn.addEventListener("click", async () => {
          // Check if session has running processes or important content
          if (s.hasChildProcesses) {
            const confirmed = confirm(
              `Session "${s.name}" contains running processes or important content (like Claude Code history). Deleting it will lose this data.\n\nAre you sure you want to delete this session?`
            );
            if (!confirmed) return;
          }
          try { await fetch(`/sessions/${encodeURIComponent(s.name)}`, { method: "DELETE" }); } catch {}
          await renderSessionList(currentSession);
        });
        row.appendChild(delBtn);
        sessionListEl.appendChild(row);
      }
    }

    document.getElementById("session-new-create").addEventListener("click", async () => {
      const name = sessionNewName.value.trim();
      if (!name) return;
      try {
        const res = await fetch("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (res.ok) {
          const data = await res.json();
          sessionNewName.value = "";
          window.open(`/?s=${encodeURIComponent(data.name)}`, "_blank");
          await renderSessionList(state.session.name);
        } else {
          console.error(`[Session] Create failed: ${res.status} ${res.statusText}`);
        }
      } catch (err) {
        console.error("[Session] Create error:", err);
      }
    });

    sessionNewName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("session-new-create").click();
    });
    

    // --- Settings ---

    const settingsOverlay = document.getElementById("settings-overlay");

    document.querySelectorAll(".theme-toggle button").forEach(btn => {
      btn.addEventListener("click", () => applyTheme(btn.dataset.themeVal));
    });
    document.getElementById("settings-logout").addEventListener("click", async () => {
      await fetch("/auth/logout", {
        method: "POST",
        headers: addCsrfHeader()
      });
      location.href = "/login";
    });

    // --- Settings tabs ---

    document.querySelectorAll(".settings-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        const targetTab = tab.dataset.tab;

        // Update tab buttons
        document.querySelectorAll(".settings-tab").forEach(t => {
          const active = t.dataset.tab === targetTab;
          t.classList.toggle("active", active);
          t.setAttribute("aria-selected", active);
        });

        // Update tab content
        document.querySelectorAll(".settings-tab-content").forEach(content => {
          content.classList.toggle("active", content.id === `settings-tab-${targetTab}`);
        });

        // Load data when switching tabs
        if (targetTab === "lan") {
          // Device list auto-updates via reactive component
        } else if (targetTab === "remote") {
          // Clear any lingering new token display before loading tokens
          const tokensList = document.getElementById("tokens-list");
          const staleNewToken = tokensList?.querySelector('.token-item-new');
          if (staleNewToken) {
            staleNewToken.remove();
          }
          loadTokens();
        }
      });
    });

    // --- Device management (reactive component) ---

    // Create device store and component
    const deviceStore = createDeviceStore();
    const deviceListComponent = createDeviceListComponent(deviceStore, {
      onRename: renameDevice,
      onRemove: removeDevice
    });

    // Mount device list component
    const devicesList = document.getElementById("devices-list");
    deviceListComponent.mount(devicesList);

    async function renameDevice(deviceId) {
      const newName = prompt("Enter new device name:");
      if (!newName || newName.trim().length === 0) return;

      try {
        const res = await fetch(`/auth/devices/${deviceId}/name`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName.trim() }),
        });
        if (!res.ok) throw new Error("Failed to rename device");
        invalidateDevices(deviceStore); // Auto-reload via store
      } catch (err) {
        alert("Failed to rename device: " + err.message);
      }
    }

    async function removeDevice(deviceId, isCurrent) {
      // Different warning messages based on whether it's the current device
      const message = isCurrent
        ? "WARNING: You are about to remove THIS DEVICE (the one you're using right now).\n\nYou will be LOGGED OUT IMMEDIATELY and will need to re-register this device to access Katulong again.\n\nAre you sure you want to continue?"
        : "Are you sure you want to remove this device? It will need to be re-registered to access Katulong again.";

      if (!confirm(message)) {
        return;
      }

      try {
        const res = await fetch(`/auth/devices/${deviceId}`, {
          method: "DELETE",
          headers: addCsrfHeader()
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to remove device");
        }

        // If we removed the current device, we'll be logged out - redirect to login
        if (isCurrent) {
          window.location.href = "/login";
        } else {
          invalidateDevices(deviceStore); // Auto-reload via store
        }
      } catch (err) {
        alert("Failed to remove device: " + err.message);
      }
    }

    // --- Token management ---

    /**
     * Creates token item HTML
     * @param {Object} token - Token data
     * @returns {string} Token item HTML
     */
    function tokenItemTemplate(token) {
      const createdDate = token.createdAt ? new Date(token.createdAt).toLocaleDateString() : 'Unknown';

      // Check if token has been used to register a device
      const hasCredential = token.credential !== null && token.credential !== undefined;

      let iconClass, statusText, metaText;
      if (hasCredential) {
        // Token was used - show device info
        iconClass = 'ph-device-mobile'; // Device icon
        const lastAuth = token.credential.lastUsedAt ? formatRelativeTime(token.credential.lastUsedAt) : 'Never';
        statusText = `<span class="token-status-active">Active device</span>`;
        metaText = `Registered: ${createdDate} · Last authenticated: ${lastAuth}`;

        // Add user agent info if available
        if (token.credential.userAgent && token.credential.userAgent !== 'Unknown') {
          metaText += `<br><span class="token-device-info">${escapeHtml(token.credential.userAgent)}</span>`;
        }
      } else {
        // Token not used yet - show as unused
        iconClass = 'ph-key'; // Key icon
        statusText = `<span class="token-status-unused">Unused</span>`;
        metaText = `Created: ${createdDate}`;
      }

      return `
        <div class="token-item ${hasCredential ? 'token-item-used' : ''}" data-token-id="${token.id}" data-has-credential="${hasCredential}">
          <div class="token-header">
            <i class="token-icon ph ${iconClass}"></i>
            <span class="token-name">${escapeHtml(token.name)}</span>
            ${statusText}
          </div>
          <div class="token-meta">
            ${metaText}
          </div>
          <div class="token-actions">
            <button class="token-btn" data-action="rename" data-id="${token.id}">Rename</button>
            <button class="token-btn token-btn-danger" data-action="revoke" data-id="${token.id}">Revoke</button>
          </div>
        </div>
      `;
    }

    async function loadTokens() {
      const tokensList = document.getElementById("tokens-list");

      // Preserve any newly created token display by cloning before DOM wipe
      const newTokenEl = tokensList.querySelector('.token-item-new');
      const clonedNewToken = newTokenEl ? newTokenEl.cloneNode(true) : null;
      const newTokenValue = clonedNewToken?.querySelector('.token-copy-btn')?.dataset?.token;

      try {
        tokensList.innerHTML = '<p class="tokens-loading">Loading tokens...</p>';

        const res = await fetch("/api/tokens");
        if (!res.ok) throw new Error("Failed to load tokens");
        const { tokens } = await res.json();

        // Filter out the newly created token if it's being displayed separately
        const newTokenId = newTokenEl?.dataset?.tokenId;
        const filteredTokens = newTokenId
          ? tokens.filter(token => token.id !== newTokenId)
          : tokens;

        // Render the token list
        if (filteredTokens.length === 0) {
          tokensList.innerHTML = '<p class="tokens-empty">No setup tokens yet. Generate one to pair remote devices.</p>';
        } else {
          // Create renderer for existing tokens
          const renderer = new ListRenderer(tokensList, {
            itemTemplate: tokenItemTemplate,
            emptyState: '<p class="tokens-empty">No setup tokens yet. Generate one to pair remote devices.</p>',
            onAction: ({ action, id, element }) => {
              if (action === 'rename') {
                renameToken(id);
              } else if (action === 'revoke') {
                const tokenItem = element.closest('.token-item');
                const hasCredential = tokenItem.dataset.hasCredential === 'true';
                revokeToken(id, hasCredential);
              }
            }
          });
          renderer.render(filteredTokens);
        }

        // Insert the cloned new token at the top (after rendering the list)
        if (clonedNewToken) {
          tokensList.insertBefore(clonedNewToken, tokensList.firstChild);

          // Re-attach event listeners (cloneNode doesn't copy listeners)
          const copyBtn = clonedNewToken.querySelector(".token-copy-btn");
          if (copyBtn) {
            copyBtn.addEventListener("click", async () => {
              const token = newTokenValue;
              try {
                await navigator.clipboard.writeText(token);
                copyBtn.innerHTML = '<i class="ph ph-check"></i> Copied!';
                copyBtn.style.background = "var(--success)";
                setTimeout(() => {
                  copyBtn.innerHTML = '<i class="ph ph-copy"></i> Copy';
                  copyBtn.style.background = "";
                }, 2000);
              } catch (err) {
                copyBtn.innerHTML = '<i class="ph ph-x"></i> Failed';
                setTimeout(() => {
                  copyBtn.innerHTML = '<i class="ph ph-copy"></i> Copy';
                }, 2000);
              }
            });
          }

          const doneBtn = clonedNewToken.querySelector("#token-done-btn");
          if (doneBtn) {
            doneBtn.addEventListener("click", () => {
              clonedNewToken.remove();
              loadTokens(); // Reload normal token list
            });
          }
        }
      } catch (err) {
        tokensList.innerHTML = '<p class="tokens-loading">Failed to load tokens</p>';
        console.error("Failed to load tokens:", err);
      }
    }

    // Token creation form handlers
    const tokenCreateForm = document.getElementById("token-create-form");
    const tokenNameInput = document.getElementById("token-name-input");
    const tokenFormSubmit = document.getElementById("token-form-submit");
    const tokenFormCancel = document.getElementById("token-form-cancel");
    const createTokenBtn = document.getElementById("settings-create-token");

    if (!tokenCreateForm || !tokenNameInput || !tokenFormSubmit || !tokenFormCancel || !createTokenBtn) {
      console.error("Token form elements not found:", {
        tokenCreateForm: !!tokenCreateForm,
        tokenNameInput: !!tokenNameInput,
        tokenFormSubmit: !!tokenFormSubmit,
        tokenFormCancel: !!tokenFormCancel,
        createTokenBtn: !!createTokenBtn
      });
    }

    // Show form when "Generate New Token" is clicked
    if (createTokenBtn) {
      createTokenBtn.addEventListener("click", () => {
        console.log("Generate New Token clicked");
        tokenCreateForm.style.display = "block";
        tokenNameInput.value = "";
        tokenNameInput.focus();
        createTokenBtn.style.display = "none";
      });
    }

    // Hide form when "Cancel" is clicked
    if (tokenFormCancel) {
      tokenFormCancel.addEventListener("click", () => {
        tokenCreateForm.style.display = "none";
        createTokenBtn.style.display = "block";
        tokenNameInput.value = "";
      });
    }

    // Enable/disable submit button based on input
    if (tokenNameInput && tokenFormSubmit) {
      tokenNameInput.addEventListener("input", () => {
        tokenFormSubmit.disabled = tokenNameInput.value.trim().length === 0;
      });
    }

    // Submit form when "Generate token" is clicked
    if (tokenFormSubmit) {
      tokenFormSubmit.addEventListener("click", async () => {
        console.log("Generate token button clicked, name:", tokenNameInput.value);
        const name = tokenNameInput.value.trim();
        if (!name) {
          console.log("No name provided, aborting");
          return;
        }

        console.log("Disabling submit button and creating token...");
        tokenFormSubmit.disabled = true;
        tokenFormSubmit.textContent = "Generating...";

        try {
          console.log("Fetching /api/tokens with name:", name);
          const res = await fetch("/api/tokens", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          console.log("Response status:", res.status);
          if (!res.ok) throw new Error("Failed to create token");
          const data = await res.json();
          console.log("Token created successfully:", data);

        // Hide form and reset
        tokenCreateForm.style.display = "none";
        tokenNameInput.value = "";
        tokenFormSubmit.textContent = "Generate token";
        createTokenBtn.style.display = "block";

        // Display the token in the UI with copy button (1Password-style)
        showNewTokenInList(data);
      } catch (err) {
        alert("Failed to create token: " + err.message);
        tokenFormSubmit.disabled = false;
        tokenFormSubmit.textContent = "Generate token";
      }
      });
    }

    // Allow Enter key to submit form
    if (tokenNameInput && tokenFormSubmit) {
      tokenNameInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter" && tokenNameInput.value.trim().length > 0) {
          tokenFormSubmit.click();
        }
      });
    }

    function showNewTokenInList(tokenData) {
      console.log("showNewTokenInList called with:", tokenData);
      const tokensList = document.getElementById("tokens-list");
      console.log("tokens-list element:", tokensList);

      // Create a special UI element for the newly created token
      const newTokenEl = document.createElement("div");
      newTokenEl.className = "token-item token-item-new";
      newTokenEl.dataset.tokenId = tokenData.id; // Store token ID to filter out duplicates
      console.log("Created new token element");
      newTokenEl.innerHTML = `
        <div class="token-header">
          <i class="token-icon ph ph-key"></i>
          <span class="token-name">${escapeHtml(tokenData.name)}</span>
          <span class="token-new-badge">New</span>
        </div>
        <div class="token-reveal-warning">
          <i class="ph ph-warning"></i> Save this token now - you won't see it again!
        </div>
        <div class="token-value-container">
          <input type="text" class="token-value-field" value="${escapeHtml(tokenData.token)}" readonly />
          <button class="token-copy-btn" data-token="${escapeHtml(tokenData.token)}">
            <i class="ph ph-copy"></i> Copy
          </button>
        </div>
        <div class="token-actions">
          <button class="token-btn" id="token-done-btn">Done</button>
        </div>
      `;

      // Insert at the top of the list
      tokensList.insertBefore(newTokenEl, tokensList.firstChild);

      // Add copy button handler
      const copyBtn = newTokenEl.querySelector(".token-copy-btn");
      copyBtn.addEventListener("click", async () => {
        const token = copyBtn.dataset.token;
        try {
          await navigator.clipboard.writeText(token);
          copyBtn.innerHTML = '<i class="ph ph-check"></i> Copied!';
          copyBtn.style.background = "var(--success)";
          setTimeout(() => {
            copyBtn.innerHTML = '<i class="ph ph-copy"></i> Copy';
            copyBtn.style.background = "";
          }, 2000);
        } catch (err) {
          copyBtn.innerHTML = '<i class="ph ph-x"></i> Failed';
          setTimeout(() => {
            copyBtn.innerHTML = '<i class="ph ph-copy"></i> Copy';
          }, 2000);
        }
      });

      // Add done button handler
      const doneBtn = newTokenEl.querySelector("#token-done-btn");
      doneBtn.addEventListener("click", () => {
        newTokenEl.remove();
        loadTokens(); // Reload normal token list
      });

      // Load the rest of the tokens below
      loadTokens();
    }

    async function renameToken(tokenId) {
      const newName = prompt("Enter new token name:");
      if (!newName || newName.trim().length === 0) return;

      try {
        const res = await fetch(`/api/tokens/${tokenId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName.trim() }),
        });
        if (!res.ok) throw new Error("Failed to rename token");
        loadTokens(); // Reload to show updated name
      } catch (err) {
        alert("Failed to rename token: " + err.message);
      }
    }

    async function revokeToken(tokenId, hasCredential = false) {
      const message = hasCredential
        ? "Are you sure you want to revoke this device? The device will immediately lose access and need to re-register."
        : "Are you sure you want to revoke this token? It will no longer work for device pairing.";

      if (!confirm(message)) {
        return;
      }

      try {
        const res = await fetch(`/api/tokens/${tokenId}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error("Failed to revoke token");
        loadTokens(); // Reload to show updated list
      } catch (err) {
        alert("Failed to revoke: " + err.message);
      }
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

    function switchSettingsView(toView) {
      const current = settingsViews.querySelector(".settings-view.active");
      if (current === toView) return;

      // Measure target height
      toView.style.position = "relative";
      toView.style.visibility = "hidden";
      toView.style.opacity = "0";
      toView.classList.add("active");
      const targetHeight = toView.scrollHeight;
      toView.classList.remove("active");
      toView.style.position = "";
      toView.style.visibility = "";
      toView.style.opacity = "";

      // Animate wrapper height
      settingsViews.style.height = (current ? current.scrollHeight : 0) + "px";
      requestAnimationFrame(() => {
        settingsViews.style.height = targetHeight + "px";
      });

      // Cross-fade
      if (current) current.classList.remove("active");
      toView.classList.add("active");

      // Clear explicit height after transition
      const onEnd = () => {
        settingsViews.style.height = "";
        settingsViews.removeEventListener("transitionend", onEnd);
      };
      settingsViews.addEventListener("transitionend", onEnd);
    }

    // Wizard control functions (component handles rendering)
    async function startTrustStep() {
      wizardStore.dispatch({ type: WIZARD_ACTIONS.START_TRUST });
    }

    async function startPairingStep() {
      try {
        const res = await fetch("/auth/pair/start", {
          method: "POST",
          headers: addCsrfHeader()
        });
        if (!res.ok) return;
        const data = await res.json();

        wizardStore.dispatch({
          type: WIZARD_ACTIONS.START_PAIRING,
          code: data.code,
          pin: data.pin,
          url: data.url,
          expiresAt: data.expiresAt
        });
      } catch (err) {
        console.error('[Wizard] Failed to start pairing:', err);
        wizardStore.dispatch({
          type: WIZARD_ACTIONS.PAIRING_ERROR,
          error: "Failed to generate pairing code"
        });
      }
    }

    function cleanupWizard() {
      wizardStore.dispatch({ type: WIZARD_ACTIONS.RESET });
      switchSettingsView(viewMain);
    }

    // Update settings modal to include cleanup on close
    const settingsModal = modals.get('settings');
    if (settingsModal) {
      const originalOnClose = settingsModal.options.onClose;
      settingsModal.options.onClose = () => {
        cleanupWizard();
        if (originalOnClose) originalOnClose();
      };
    }

    // Event: Pair Device → step 1 (trust)
    document.getElementById("settings-pair-lan").addEventListener("click", async () => {
      switchSettingsView(viewTrust);
      await startTrustStep();
    });

    // Event: Next → step 2 (pair)
    document.getElementById("wizard-next-pair").addEventListener("click", async () => {
      switchSettingsView(viewPair);
      await startPairingStep();
    });

    // Event: Back from trust → main
    document.getElementById("wizard-back-trust").addEventListener("click", () => {
      wizardStore.dispatch({ type: WIZARD_ACTIONS.RESET });
      switchSettingsView(viewMain);
    });

    // Event: Back from pair → trust
    document.getElementById("wizard-back-pair").addEventListener("click", () => {
      wizardStore.dispatch({ type: WIZARD_ACTIONS.RESET });
      switchSettingsView(viewTrust);
      startTrustStep();
    });

    // Event: Done → cleanup + show LAN tab with newly paired device
    document.getElementById("wizard-done").addEventListener("click", () => {
      cleanupWizard();
      // Switch to main view
      switchSettingsView(viewMain);

      // Switch to LAN tab to show newly paired device
      const lanTab = document.querySelector('.settings-tab[data-tab="lan"]');
      if (lanTab) lanTab.click();
    });

    // --- Dictation modal ---

    const dictationOverlay = document.getElementById("dictation-overlay");
    const dictationInput = document.getElementById("dictation-input");
    const dictationThumbs = document.getElementById("dictation-thumbs");
    const dictationFileInput = document.getElementById("dictation-file-input");

    // --- Dictation state management (immutable reducer) ---
    const dictationReducer = (images, action) => {
      switch (action.type) {
        case 'ADD_IMAGES':
          return [...images, ...action.files];
        case 'REMOVE_IMAGE':
          return images.filter((_, idx) => idx !== action.index);
        case 'CLEAR':
          return [];
        default:
          return images;
      }
    };

    let dictationImages = [];

    const dispatchDictation = (action) => {
      dictationImages = dictationReducer(dictationImages, action);
      renderDictationThumbs();
    };

    function renderDictationThumbs() {
      dictationThumbs.innerHTML = "";
      dictationImages.forEach((file, i) => {
        const wrap = document.createElement("div");
        wrap.className = "dictation-thumb";
        const img = document.createElement("img");
        img.src = URL.createObjectURL(file);
        img.alt = file.name;
        wrap.appendChild(img);
        const rm = document.createElement("button");
        rm.className = "dictation-thumb-remove";
        rm.setAttribute("aria-label", `Remove ${file.name}`);
        rm.innerHTML = '<i class="ph ph-x"></i>';
        rm.addEventListener("click", () => {
          URL.revokeObjectURL(img.src);
          dispatchDictation({ type: 'REMOVE_IMAGE', index: i });
        });
        wrap.appendChild(rm);
        dictationThumbs.appendChild(wrap);
      });
    }

    dictationFileInput.addEventListener("change", () => {
      const files = [...dictationFileInput.files].filter(f => f.type.startsWith("image/"));
      dispatchDictation({ type: 'ADD_IMAGES', files });
      dictationFileInput.value = "";
    });

    function openDictationModal() {
      dictationInput.value = "";
      dispatchDictation({ type: 'CLEAR' });
      modals.open('dictation');
      dictationInput.focus();
    }

    function closeDictationModal() {
      dictationInput.value = "";
      dispatchDictation({ type: 'CLEAR' });
      modals.close('dictation');
    }

    document.getElementById("dictation-send").addEventListener("click", async () => {
      const text = dictationInput.value;
      const images = [...dictationImages];
      closeDictationModal();
      if (text) rawSend(text);
      for (const file of images) {
        await uploadImage(file);
      }
    });

    

    // --- Image upload helpers ---

    function showToast(msg, isError) {
      const el = document.createElement("div");
      el.className = "upload-toast" + (isError ? " error" : "");
      el.textContent = msg;
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add("visible"));
      setTimeout(() => {
        el.classList.remove("visible");
        setTimeout(() => el.remove(), 300);
      }, 2500);
    }

    async function uploadImage(file) {
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

    function isImageFile(file) {
      return file.type.startsWith("image/");
    }

    // --- Drag-and-drop state machine ---

    const dropOverlay = document.getElementById("drop-overlay");

    // Drag-and-drop state machine
    const dragDropReducer = (state, action) => {
      switch (action.type) {
        case 'DRAG_ENTER':
          return {
            ...state,
            dragCounter: state.dragCounter + 1,
            isDragging: true
          };
        case 'DRAG_LEAVE':
          const newCounter = state.dragCounter - 1;
          return {
            ...state,
            dragCounter: Math.max(0, newCounter),
            isDragging: newCounter > 0
          };
        case 'DROP':
          return {
            dragCounter: 0,
            isDragging: false
          };
        default:
          return state;
      }
    };

    // Drag-and-drop manager (stateful edge module)
    const createDragDropManager = () => {
      let dragState = { dragCounter: 0, isDragging: false };

      const dispatch = (action) => {
        const prevState = dragState;
        dragState = dragDropReducer(dragState, action);

        // Side effect: Update overlay visibility
        if (prevState.isDragging !== dragState.isDragging) {
          if (dragState.isDragging) {
            dropOverlay.classList.add("visible");
          } else {
            dropOverlay.classList.remove("visible");
          }
        }
      };

      return { dispatch, getState: () => dragState };
    };

    const dragDropManager = createDragDropManager();

    document.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDropManager.dispatch({ type: 'DRAG_ENTER' });
    });

    document.addEventListener("dragover", (e) => {
      e.preventDefault();
    });

    document.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDropManager.dispatch({ type: 'DRAG_LEAVE' });
    });

    document.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDropManager.dispatch({ type: 'DROP' });
      const files = [...(e.dataTransfer?.files || [])].filter(isImageFile);
      if (files.length === 0) {
        if (e.dataTransfer?.files?.length > 0) showToast("Not an image file", true);
        return;
      }
      for (const file of files) uploadImage(file);
    });

    // --- Global paste ---

    document.addEventListener("paste", (e) => {
      // Check for pasted images first (e.g., screenshots)
      const imageFiles = [...(e.clipboardData?.files || [])].filter(isImageFile);
      if (imageFiles.length > 0) {
        e.preventDefault();
        for (const file of imageFiles) uploadImage(file);
        return;
      }
      const text = e.clipboardData?.getData("text");
      if (text) { rawSend(text); e.preventDefault(); }
    });

    // --- Network change: re-establish P2P ---

    function onNetworkChange() {
      if (!state.connection.ws || state.connection.ws.readyState !== 1) return;
      console.log("[P2P] Network change detected, re-establishing");
      p2pManager.create();
    }

    window.addEventListener("online", onNetworkChange);
    if (navigator.connection) {
      navigator.connection.addEventListener("change", onNetworkChange);
    }

    // --- Boot ---

    renderBar(state.session.name);  // Initial render
    connect();
    loadShortcuts();
    term.focus();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
