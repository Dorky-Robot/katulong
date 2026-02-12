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
    import { createSessionStore, invalidateSessions } from "/lib/session-store.js";
    import { createSessionListComponent } from "/lib/session-list-component.js";
    import { createTokenStore, setNewToken, invalidateTokens } from "/lib/token-store.js";
    import { createTokenListComponent } from "/lib/token-list-component.js";
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
    shortcutsStore.subscribe((shortcuts) => {
      // Update legacy state object (for backward compatibility)
      state.update('session.shortcuts', shortcuts);

      // Re-render bar when shortcuts change
      renderBar(state.session.name);
    });

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

    // --- Shortcuts popup (reactive component) ---

    const shortcutsPopup = createShortcutsPopup({
      onShortcutClick: (keys) => {
        sendSequence(keysToSequence(keys));
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

    const sessionOverlay = document.getElementById("session-overlay");
    const sessionStore = createSessionStore(state.session.name);
    const sessionListComponent = createSessionListComponent(sessionStore);
    const sessionListEl = document.getElementById("session-list");
    if (sessionListEl) {
      sessionListComponent.mount(sessionListEl);
    }
    const sessionNewName = document.getElementById("session-new-name");

    async function openSessionManager() {
      modals.open('session');
      invalidateSessions(sessionStore, state.session.name);
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
          invalidateSessions(sessionStore, state.session.name);
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

    const tokenStore = createTokenStore();
    const tokenListComponent = createTokenListComponent(tokenStore, {
      onRename: renameToken,
      onRevoke: revokeToken
    });
    const tokensList = document.getElementById("tokens-list");
    if (tokensList) {
      tokenListComponent.mount(tokensList);
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
        setNewToken(tokenStore, data);
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
        invalidateTokens(tokenStore); // Reload to show updated name
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
        invalidateTokens(tokenStore); // Reload to show updated list
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
    const pairLanBtn = document.getElementById("settings-pair-lan");
    if (pairLanBtn) {
      pairLanBtn.addEventListener("click", async () => {
        switchSettingsView(viewTrust);
        await startTrustStep();
      });
    }

    // Event: Next → step 2 (pair)
    const wizardNextBtn = document.getElementById("wizard-next-pair");
    if (wizardNextBtn) {
      wizardNextBtn.addEventListener("click", async () => {
        switchSettingsView(viewPair);
        await startPairingStep();
      });
    }

    // Event: Back from trust → main
    const wizardBackTrustBtn = document.getElementById("wizard-back-trust");
    if (wizardBackTrustBtn) {
      wizardBackTrustBtn.addEventListener("click", () => {
        wizardStore.dispatch({ type: WIZARD_ACTIONS.RESET });
        switchSettingsView(viewMain);
      });
    }

    // Event: Back from pair → trust
    const wizardBackPairBtn = document.getElementById("wizard-back-pair");
    if (wizardBackPairBtn) {
      wizardBackPairBtn.addEventListener("click", () => {
        wizardStore.dispatch({ type: WIZARD_ACTIONS.RESET });
        switchSettingsView(viewTrust);
        startTrustStep();
      });
    }

    // Event: Done → cleanup + show LAN tab with newly paired device
    const wizardDoneBtn = document.getElementById("wizard-done");
    if (wizardDoneBtn) {
      wizardDoneBtn.addEventListener("click", () => {
        cleanupWizard();
        switchSettingsView(viewMain);

        // Switch to LAN tab to show newly paired device
        const lanTab = document.querySelector('.settings-tab[data-tab="lan"]');
        if (lanTab) lanTab.click();
      });
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

    document.addEventListener("paste", (e) => {
      // Check for pasted images first (e.g., screenshots)
      const imageFiles = [...(e.clipboardData?.files || [])].filter(isImageFile);
      if (imageFiles.length > 0) {
        e.preventDefault();
        for (const file of imageFiles) uploadImageToTerminal(file);
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
