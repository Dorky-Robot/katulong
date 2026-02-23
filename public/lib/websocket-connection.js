/**
 * WebSocket Connection Manager
 *
 * Handles WebSocket connection lifecycle, message routing, and effects.
 * Uses functional core / imperative shell pattern with dependency injection.
 */

import { scrollToBottom, terminalWriteWithScroll } from "/lib/scroll-utils.js";

/**
 * Create WebSocket connection manager with injected dependencies
 */
export function createWebSocketConnection(deps = {}) {
  const {
    term,
    state,
    p2pManager,
    updateP2PIndicator,
    loadTokens,
    isAtBottom
  } = deps;

  let isConnecting = false;
  let reconnectTimeout = null;

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
    }),

    'credential-removed': () => ({
      stateUpdates: {},
      effects: []
    }),

    'p2p-signal': (msg, currentState) => ({
      stateUpdates: {},
      effects: currentState.p2p?.peer
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
    })
  };

  // Effect executor (side effects at edges)
  function executeEffect(effect) {
    switch (effect.type) {
      case 'updateP2PIndicator':
        if (updateP2PIndicator) updateP2PIndicator();
        break;
      case 'initP2P':
        if (p2pManager) p2pManager.create();
        break;
      case 'p2pSignal':
        if (p2pManager) p2pManager.signal(effect.data);
        break;
      case 'log':
        console.log(effect.message);
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
      case 'reload':
        location.reload();
        break;
      case 'updateSessionUI':
        document.title = effect.name;
        const url = new URL(window.location);
        url.searchParams.set("s", effect.name);
        history.replaceState(null, "", url);
        // Call render bar via callback if provided
        if (deps.renderBar) deps.renderBar(effect.name);
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

  // WebSocket connection function
  function connect() {
    // Prevent multiple simultaneous connection attempts
    if (isConnecting) {
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
        const { stateUpdates, effects } = handler(msg, state);

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
        window.location.href = '/login?reason=revoked';
        return;
      }

      // Normal disconnect - attempt reconnection with exponential backoff
      const viewport = document.querySelector(".xterm-viewport");
      state.scroll.userScrolledUpBeforeDisconnect = !isAtBottom(viewport);
      state.connection.attached = false;
      if (p2pManager) p2pManager.destroy();

      console.log(`[WS] Reconnecting in ${state.connection.reconnectDelay}ms`);
      reconnectTimeout = setTimeout(connect, state.connection.reconnectDelay);
      state.connection.reconnectDelay = Math.min(state.connection.reconnectDelay * 2, 10000);
    };

    state.connection.ws.onerror = () => {
      isConnecting = false;
      state.connection.ws.close();
    };
  }

  // Visibility change handler for reconnection after backgrounding
  function initVisibilityReconnect() {
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        // Coming back to foreground
        const hiddenDuration = Date.now() - hiddenAt;

        // Skip if already connecting
        if (isConnecting) {
          return;
        }

        // If was hidden for more than 5 seconds, force reconnect
        if (hiddenDuration > 5000 && state.connection.ws && !isConnecting) {
          state.connection.ws.close();
        } else if (state.connection.ws && state.connection.ws.readyState === WebSocket.OPEN) {
          // Quick test - send resize to verify connection is alive
          try {
            state.connection.ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          } catch {
            state.connection.ws.close();
          }
        }
      }
    });
  }

  return {
    connect,
    initVisibilityReconnect,
    wsMessageHandlers,
    executeEffect
  };
}
