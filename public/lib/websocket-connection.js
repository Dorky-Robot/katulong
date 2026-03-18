/**
 * WebSocket Connection Manager
 *
 * Handles WebSocket connection lifecycle, message routing, and effects.
 * Uses functional core / imperative shell pattern with dependency injection.
 */

import { scrollToBottom, terminalWriteWithScroll, isAtBottom } from "/lib/scroll-utils.js";
import { basePath } from "/lib/base-path.js";
import { createSeqBuffer } from "/lib/seq-buffer.js";
import { createNudgeTimer } from "/lib/nudge-timer.js";

/**
 * Connection state machine: DISCONNECTED → CONNECTING → CONNECTED → ATTACHED
 * Only valid transitions are forward through this sequence, or back to DISCONNECTED.
 */
export const CONNECTION_STATES = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ATTACHED: 'attached'
};

/**
 * Create WebSocket connection manager with injected dependencies
 */
export function createWebSocketConnection(deps = {}) {
  const {
    state,
    p2pManager,
    updateP2PIndicator,
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

  let connectionState = CONNECTION_STATES.DISCONNECTED;
  let reconnectTimeout = null;
  let suppressReconnect = false;

  // Helper: send a catchup request to the server
  // (Catchup trigger 1/2: gap timeout in seq-buffer; 2/2: nudge poll in seqStatus effect)
  function sendCatchup(session, fromSeq) {
    const ws = state.connection.ws;
    if (ws && ws.readyState === 1 && session) {
      ws.send(JSON.stringify({ type: "catchup", session, fromSeq }));
    }
  }

  // Sequence tracking for ordered output delivery
  const seqBuffer = createSeqBuffer({
    onFlush: (data) => {
      // Route through the same RAF batching path used by direct writes
      const term = getOutputTerm(state.session.name);
      if (term) scheduleWrite(term, data);
    },
    onGapTimeout: (expectedSeq) => {
      // Catchup trigger 1/2: gap in seq-ordered stream (see also seqStatus effect)
      sendCatchup(state.session.name, expectedSeq);
    },
  });

  const nudgeTimer = createNudgeTimer({
    getWS: () => state.connection.ws,
  });

  // Output write batching: accumulate incoming data per terminal and flush
  // once per animation frame to reduce xterm.js write/render passes.
  const pendingWrites = new Map(); // term -> string
  let rafScheduled = false;

  function scheduleWrite(term, data) {
    const pending = pendingWrites.get(term);
    pendingWrites.set(term, pending !== undefined ? pending + data : data);
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        for (const [t, buf] of pendingWrites) {
          terminalWriteWithScroll(t, buf);
        }
        pendingWrites.clear();
      });
    }
  }

  // --- Pure WebSocket message handlers (functional core) ---
  const wsMessageHandlers = {
    attached: (msg, currentState) => ({
      stateUpdates: {
        'connection.attached': true,
        'session.name': msg.session,
        'scroll.userScrolledUpBeforeDisconnect': false
      },
      effects: [
        { type: 'terminalReset' },
        { type: 'updateSessionUI', name: msg.session },
        { type: 'updateP2PIndicator' },
        { type: 'initP2P' },
        { type: 'fit' },
        { type: 'invalidateSessions', name: msg.session },
        { type: 'scrollToBottomIfNeeded', condition: !currentState.scroll.userScrolledUpBeforeDisconnect }
      ]
    }),

    switched: (msg) => ({
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
    }),

    output: (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'seqOutput', data: msg.data, session: msg.session, seq: msg.seq }
      ]
    }),

    reload: () => ({
      stateUpdates: {},
      effects: [{ type: 'reload' }]
    }),

    exit: (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'terminalWrite', data: '\r\n[shell exited]\r\n', session: msg.session, preserveScroll: true, useOutputTerm: true }]
    }),

    'session-removed': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'sessionRemoved', name: msg.session }]
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

    'paste-complete': (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'pasteComplete', path: msg.path }
      ]
    }),

    'resize-sync': (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'resizeSync', cols: msg.cols, rows: msg.rows }
      ]
    }),

    'seq-init': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'seqInit', session: msg.session, seq: msg.seq }]
    }),

    'seq-status': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'seqStatus', session: msg.session, seq: msg.seq }]
    }),

    'catchup-data': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'seqOutput', data: msg.data, session: msg.session, seq: msg.seq }]
    }),

    'seq-reset': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'seqReset', session: msg.session }]
    }),

    'server-draining': () => ({
      stateUpdates: {},
      effects: [
        { type: 'log', message: '[WS] Server is draining, reconnecting immediately' },
        { type: 'fastReconnect' }
      ]
    }),

    // --- Helm mode events ---

    'helm-mode-changed': (msg) => ({
      stateUpdates: {},
      effects: [{
        type: 'helmModeChanged', session: msg.session, active: msg.active,
        agent: msg.agent, prompt: msg.prompt, cwd: msg.cwd,
        result: msg.result, error: msg.error,
      }]
    }),

    'helm-event': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'helmEvent', session: msg.session, event: msg.event }]
    }),

    'helm-turn-complete': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'helmTurnComplete', session: msg.session }]
    }),

    'helm-waiting-for-input': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'helmWaitingForInput', session: msg.session }]
    }),

    'tab-icon-changed': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'tabIconChanged', session: msg.session, icon: msg.icon }]
    }),
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
      case 'pasteComplete':
        if (deps.onPasteComplete) deps.onPasteComplete(effect.path);
        break;
      case 'scrollToBottomIfNeeded': {
        const term = getTerm();
        if (effect.condition && term) {
          scrollToBottom(term);
        }
        break;
      }
      case 'seqOutput': {
        nudgeTimer.reset();
        if (effect.seq !== undefined && seqBuffer.isInitialized()) {
          seqBuffer.push(effect.seq, effect.data);
        } else {
          // No seq (backward compat) or seq-init not yet received — write directly
          const term = effect.useOutputTerm !== false ? getOutputTerm(effect.session) : getTerm();
          if (term) scheduleWrite(term, effect.data);
        }
        break;
      }
      case 'seqInit':
        seqBuffer.init(effect.seq);
        nudgeTimer.start();
        break;
      case 'seqStatus': {
        // Catchup trigger 2/2: nudge poll revealed lag (see also onGapTimeout)
        const expected = seqBuffer.getExpectedSeq();
        if (seqBuffer.isInitialized() && effect.seq > expected) {
          sendCatchup(effect.session, expected);
        }
        break;
      }
      case 'seqReset':
        // Data evicted — force reconnect to get fresh buffer replay
        seqBuffer.clear();
        if (state.connection.ws) state.connection.ws.close();
        break;
      case 'terminalReset': {
        const term = getTerm();
        if (!term) break;
        term.clear();
        term.reset();
        break;
      }
      case 'terminalWrite': {
        const term = effect.useOutputTerm ? getOutputTerm(effect.session) : getTerm();
        if (!term) break;
        if (effect.preserveScroll) {
          scheduleWrite(term, effect.data);
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
      // Helm mode effects — delegated to app.js via deps
      case 'helmModeChanged':
        if (deps.onHelmModeChanged) deps.onHelmModeChanged(effect);
        break;
      case 'helmEvent':
        if (deps.onHelmEvent) deps.onHelmEvent(effect.session, effect.event);
        break;
      case 'helmTurnComplete':
        if (deps.onHelmTurnComplete) deps.onHelmTurnComplete(effect.session);
        break;
      case 'helmWaitingForInput':
        if (deps.onHelmWaitingForInput) deps.onHelmWaitingForInput(effect.session);
        break;
      case 'tabIconChanged':
        if (deps.onTabIconChanged) deps.onTabIconChanged(effect.session, effect.icon);
        break;
    }
  }

  // WebSocket connection function
  function connect() {
    // Only connect from DISCONNECTED state, and only if we have a session
    if (connectionState !== CONNECTION_STATES.DISCONNECTED) {
      return;
    }
    if (!state.session.name) {
      return;
    }

    // Clear any pending reconnection timeout
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    connectionState = CONNECTION_STATES.CONNECTING;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsPath = basePath ? `${basePath}/stream` : "";
    state.connection.ws = new WebSocket(`${proto}//${location.host}${wsPath}`);

    state.connection.ws.onopen = () => {
      connectionState = CONNECTION_STATES.CONNECTED;
      state.connection.reconnectDelay = 1000;
      const term = getTerm();
      const cols = term?.cols || 80;
      const rows = term?.rows || 24;
      state.connection.ws.send(JSON.stringify({ type: "attach", session: state.session.name, cols, rows }));
      state.connection.ws.send(JSON.stringify({ type: "resize", session: state.session.name, cols, rows }));
    };

    state.connection.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const handler = wsMessageHandlers[msg.type];

      if (handler) {
        const { stateUpdates, effects } = handler(msg, state);

        // Transition to ATTACHED when server confirms attachment
        if (msg.type === 'attached' || msg.type === 'switched') {
          connectionState = CONNECTION_STATES.ATTACHED;
        }

        // Apply state updates
        if (Object.keys(stateUpdates).length > 0) {
          state.updateMany(stateUpdates);
        }

        // Execute effects
        effects.forEach(executeEffect);
      }
    };

    state.connection.ws.onclose = (event) => {
      connectionState = CONNECTION_STATES.DISCONNECTED;

      // Check if connection was closed due to revoked credentials
      if (event.code === 1008) { // 1008 = Policy Violation
        window.location.href = '/login?reason=revoked';
        return;
      }

      // Normal disconnect - attempt reconnection with exponential backoff
      // (no stale state to clear — output routes by session name)
      const term = getTerm();
      state.scroll.userScrolledUpBeforeDisconnect = term ? !isAtBottom(term) : false;
      state.connection.attached = false;
      nudgeTimer.stop();
      seqBuffer.clear();
      if (p2pManager) p2pManager.destroy();
      if (deps.onDisconnect) deps.onDisconnect();

      if (suppressReconnect || !state.session.name) {
        console.log("[WS] No session — skipping reconnect");
        return;
      }
      console.log(`[WS] Reconnecting in ${state.connection.reconnectDelay}ms`);
      reconnectTimeout = setTimeout(connect, state.connection.reconnectDelay);
      state.connection.reconnectDelay = Math.min(state.connection.reconnectDelay * 2, 10000);
    };

    state.connection.ws.onerror = () => {
      // Set DISCONNECTED unconditionally — if the socket is already CLOSED,
      // calling close() is a no-op and onclose won't fire again.
      connectionState = CONNECTION_STATES.DISCONNECTED;
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
        if (connectionState === CONNECTION_STATES.CONNECTING) {
          return;
        }

        // Force reconnect after extended backgrounding to get fresh state
        if (hiddenDuration > 5000 && state.connection.ws) {
          state.connection.ws.close();
        } else if (state.connection.ws && state.connection.ws.readyState === WebSocket.OPEN) {
          // Brief background — ping with resize to verify connection
          try {
            const term = getTerm();
            const cols = term?.cols || 80;
            const rows = term?.rows || 24;
            state.connection.ws.send(JSON.stringify({ type: "resize", session: state.session.name, cols, rows }));
          } catch {
            state.connection.ws.close();
          }
        }
      }
    });
  }

  /** Disconnect and stop reconnecting (e.g., when all sessions are closed) */
  function disconnect() {
    suppressReconnect = true;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (state.connection.ws && state.connection.ws.readyState <= 1) {
      state.connection.ws.close();
    }
    connectionState = CONNECTION_STATES.DISCONNECTED;
    state.connection.attached = false;
  }

  /** Re-enable reconnection (e.g., when a new session is created) */
  function enableReconnect() {
    suppressReconnect = false;
    state.connection.reconnectDelay = 1000;
  }

  return {
    connect,
    disconnect,
    enableReconnect,
    initVisibilityReconnect,
    wsMessageHandlers,
    executeEffect,
    getConnectionState: () => connectionState,
    /** Route P2P output through the sequencing layer. */
    pushP2POutput(seq, data, session) {
      executeEffect({ type: 'seqOutput', seq, data, session });
    },
  };
}
