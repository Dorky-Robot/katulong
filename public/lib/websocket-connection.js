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
  // Route output to the correct terminal by session name (from the pool).
  // Returns null if the session has no terminal (e.g., evicted from pool).
  // Callers must handle null — dropping output is correct because background
  // sessions get a full buffer replay when switched to.
  const getTermForSession = deps.getTermForSession || null;
  const getOutputTerm = (session) => {
    if (session && getTermForSession) {
      return getTermForSession(session) || null;
    }
    return getTerm();
  };

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
        { type: 'terminalWrite', data: msg.data, session: msg.session, preserveScroll: true, useOutputTerm: true }
      ]
    }),

    reload: () => ({
      stateUpdates: {},
      effects: [{ type: 'reload' }]
    }),

    exit: (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'terminalWrite', data: '\r\n[shell exited]\r\n', session: msg.session, useOutputTerm: true }]
    }),

    'session-removed': (msg, currentState) => ({
      stateUpdates: {},
      effects: [{ type: 'sessionRemoved', name: currentState.session.name }]
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
        const term = effect.useOutputTerm ? getOutputTerm(effect.session) : getTerm();
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
        if (deps.updateSessionUI) deps.updateSessionUI(effect.name);
        break;
      case 'refreshTokensAfterRegistration':
        if (deps.refreshTokensAfterRegistration) deps.refreshTokensAfterRegistration();
        break;
      case 'sessionRemoved':
        if (deps.onSessionRemoved) deps.onSessionRemoved(effect.name);
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
        // Bounds check — reject invalid dimensions that could crash xterm.js
        if (effect.cols <= 0 || effect.rows <= 0 || effect.cols > 1000 || effect.rows > 1000) break;
        // Resize the local terminal to match the active client's dimensions.
        // Set a flag so the ResizeObserver doesn't echo this back to the server.
        if (deps.setSyncResize) deps.setSyncResize(true);
        term.resize(effect.cols, effect.rows);
        // Clear the flag after rAF — ResizeObserver fires during the
        // "update the rendering" step which follows rAF callbacks,
        // so the flag is guaranteed to still be true when the observer runs.
        requestAnimationFrame(() => { if (deps.setSyncResize) deps.setSyncResize(false); });
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
      // (no stale state to clear — output routes by session name)
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
  };
}
