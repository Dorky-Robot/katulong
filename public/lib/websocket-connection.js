/**
 * WebSocket Connection Manager
 *
 * Handles WebSocket connection lifecycle, message routing, and effects.
 * Uses functional core / imperative shell pattern with dependency injection.
 */

import { scrollToBottom, terminalWriteWithScroll, activeViewport } from "/lib/scroll-utils.js";
import { basePath } from "/lib/base-path.js";

/**
 * Create WebSocket connection manager with injected dependencies
 */
const REDRAW_SCROLL_DELAYS_MS = [300, 800];

export function createWebSocketConnection(deps = {}) {
  const {
    state,
    p2pManager,
    updateP2PIndicator,
    loadTokens,
    isAtBottom
  } = deps;

  // Support both direct terminal reference and getter function for pooled terminals
  const getTerm = typeof deps.term === "function" ? deps.term : () => deps.term;
  // During a session switch, output may still arrive for the previous session
  // before the server confirms the switch. getOutputTerm() resolves to the
  // correct terminal by checking the switchPending flag.
  const getOutputTerm = () => {
    if (switchPendingTerm) return switchPendingTerm;
    return getTerm();
  };
  let switchPendingTerm = null;

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
        { type: 'terminalReset' },
        { type: 'updateP2PIndicator' },
        { type: 'initP2P' },
        { type: 'fit' },
        { type: 'invalidateSessions', name: currentState.session.name },
        { type: 'scrollToBottomIfNeeded', condition: !currentState.scroll.userScrolledUpBeforeDisconnect }
      ]
    }),

    switched: (msg) => {
      // Server confirmed the switch — output now flows for the new session
      switchPendingTerm = null;
      return {
        stateUpdates: {
          'connection.attached': true,
          'session.name': msg.session,
        },
        effects: [
          { type: 'updateSessionUI', name: msg.session },
          { type: 'invalidateSessions', name: msg.session },
          { type: 'fit' },
          { type: 'scrollToBottomIfNeeded', condition: true }
        ]
      };
    },

    output: (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'terminalWrite', data: msg.data, preserveScroll: true, useOutputTerm: true }
      ]
    }),

    reload: () => ({
      stateUpdates: {},
      effects: [{ type: 'reload' }]
    }),

    exit: () => ({
      stateUpdates: {},
      effects: [{ type: 'terminalWrite', data: '\r\n[shell exited]\r\n', useOutputTerm: true }]
    }),

    'session-removed': () => ({
      stateUpdates: {},
      effects: [{ type: 'sessionRemoved' }]
    }),

    'session-renamed': (msg, currentState) => ({
      stateUpdates: { 'session.name': msg.name },
      effects: [
        { type: 'poolRename', oldName: currentState.session.name, newName: msg.name },
        { type: 'tabRename', oldName: currentState.session.name, newName: msg.name },
        { type: 'updateSessionUI', name: msg.name }
      ]
    }),

    'credential-registered': () => ({
      stateUpdates: {},
      effects: [{ type: 'refreshTokensAfterRegistration' }]
    }),

    'credential-removed': () => ({
      stateUpdates: {},
      effects: []
    }),

    'p2p-signal': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'p2pSignal', data: msg.data }]
    }),

    'p2p-ready': () => ({
      stateUpdates: {},
      effects: [
        { type: 'log', message: '[P2P] Server confirmed DataChannel ready' },
        { type: 'updateP2PIndicator' }
      ]
    }),

    'p2p-lan-candidates': (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'logServerLanIPs', addresses: msg.addresses }
      ]
    }),

    'p2p-unavailable': () => ({
      stateUpdates: {},
      effects: [
        { type: 'log', message: '[P2P] Server reports P2P unavailable' },
        { type: 'p2pDestroy' },
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

    'resize-sync': (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'resizeSync', cols: msg.cols, rows: msg.rows }
      ]
    }),

    'server-draining': () => ({
      stateUpdates: {},
      effects: [
        { type: 'log', message: '[WS] Server is draining, reconnecting immediately' },
        { type: 'fastReconnect' }
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
      case 'fit':
        if (deps.fit) requestAnimationFrame(() => deps.fit());
        break;
      case 'p2pSignal':
        if (p2pManager) p2pManager.signal(effect.data);
        break;
      case 'p2pDestroy':
        if (p2pManager) p2pManager.destroy();
        break;
      case 'log':
        console.log(effect.message);
        break;
      case 'logServerLanIPs':
        console.log('[P2P] Server LAN addresses:', effect.addresses);
        break;
      case 'scrollToBottomIfNeeded': {
        const term = getTerm();
        if (effect.condition && term) {
          scrollToBottom(term);
        }
        break;
      }
      case 'terminalReset': {
        const term = getTerm();
        if (!term) break;
        term.clear();
        term.reset();
        // Scroll to bottom after the server-side SIGWINCH-triggered redraw
        // arrives. Two attempts at staggered delays to handle variable
        // TUI redraw times (Claude Code, vim) and network latency.
        for (const ms of REDRAW_SCROLL_DELAYS_MS) {
          setTimeout(() => { const t = getTerm(); if (t) scrollToBottom(t); }, ms);
        }
        break;
      }
      case 'terminalWrite': {
        const term = effect.useOutputTerm ? getOutputTerm() : getTerm();
        if (!term) break;
        if (effect.preserveScroll) {
          terminalWriteWithScroll(term, effect.data);
        } else {
          term.write(effect.data);
        }
        break;
      }
      case 'reload':
        location.reload();
        break;
      case 'invalidateSessions':
        if (deps.invalidateSessions) deps.invalidateSessions(effect.name);
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
      case 'sessionRemoved':
        // Broadcast to other windows before navigating away
        if (deps.onSessionKilled) deps.onSessionKilled(state.session.name);
        // Current session was removed — navigate to closest remaining session
        fetch("/sessions").then(r => r.json()).then(sessions => {
          if (sessions.length > 0) {
            location.href = `/?s=${encodeURIComponent(sessions[0].name)}`;
          } else {
            location.href = "/";
          }
        }).catch(() => { location.href = "/"; });
        break;
      case 'poolRename':
        if (deps.poolRename) deps.poolRename(effect.oldName, effect.newName);
        break;
      case 'tabRename':
        if (deps.tabRename) deps.tabRename(effect.oldName, effect.newName);
        break;
      case 'resizeSync': {
        const term = getTerm();
        if (!term) break;
        // Resize the local terminal to match the active client's dimensions.
        // Set a flag so the ResizeObserver doesn't echo this back to the server.
        if (deps.setSyncResize) deps.setSyncResize(true);
        term.resize(effect.cols, effect.rows);
        // Clear the flag after a microtask so the ResizeObserver callback sees it
        Promise.resolve().then(() => { if (deps.setSyncResize) deps.setSyncResize(false); });
        break;
      }
      case 'fastReconnect':
        // Reset reconnect delay for fast reconnection to new server
        state.connection.reconnectDelay = 500;
        if (state.connection.ws && state.connection.ws.readyState === WebSocket.OPEN) {
          state.connection.ws.close();
        }
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
    const wsPath = basePath ? `${basePath}/stream` : "";
    state.connection.ws = new WebSocket(`${proto}//${location.host}${wsPath}`);

    state.connection.ws.onopen = () => {
      isConnecting = false;
      state.connection.reconnectDelay = 1000;
      const term = getTerm();
      const cols = term?.cols || 80;
      const rows = term?.rows || 24;
      state.connection.ws.send(JSON.stringify({ type: "attach", session: state.session.name, cols, rows }));
      state.connection.ws.send(JSON.stringify({ type: "resize", cols, rows }));
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
      switchPendingTerm = null; // Clear stale switch state on disconnect
      const viewport = activeViewport();
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
        if (hiddenDuration > 5000 && state.connection.ws) {
          state.connection.ws.close();
        } else if (state.connection.ws && state.connection.ws.readyState === WebSocket.OPEN) {
          // Quick test - send resize to verify connection is alive
          try {
            const term = getTerm();
            const cols = term?.cols || 80;
            const rows = term?.rows || 24;
            state.connection.ws.send(JSON.stringify({ type: "resize", cols, rows }));
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
    executeEffect,
    /** Set the terminal that should receive output during a session switch window */
    setSwitchPendingTerm(term) { switchPendingTerm = term; },
  };
}
