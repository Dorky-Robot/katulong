/**
 * WebSocket Connection Manager
 *
 * Handles WebSocket connection lifecycle, message routing, and effects.
 * Uses functional core / imperative shell pattern with dependency injection.
 */

import { scrollToBottom, terminalWriteWithScroll, isAtBottom } from "/lib/scroll-utils.js";
import { basePath } from "/lib/base-path.js";

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

  // --- Pull-based output: each session is an event topic (like Kafka). ---
  // Clients maintain a cursor (byte offset) into the session's RingBuffer
  // and pull data when ready.  The server sends lightweight "data-available"
  // notifications; clients respond with pull requests at their own pace.
  // Natural backpressure: the next pull only fires after xterm finishes
  // processing the previous write.

  const pullStates = new Map(); // sessionName -> { cursor, pulling, writing, pending }
  const subscribedSessions = new Set(); // tracks active subscriptions to avoid duplicates

  // Safety timeout: if a pull response doesn't arrive within this window,
  // assume it was dropped (backpressure, session gone, etc.) and unstick.
  const PULL_TIMEOUT_MS = 5000;
  const pullTimers = new Map(); // sessionName -> timeoutId

  function sendPull(sessionName) {
    const ps = pullStates.get(sessionName);
    if (!ps || ps.pulling) return;
    const ws = state.connection.ws;
    if (!ws || ws.readyState !== 1) return;
    ps.pulling = true;
    ws.send(JSON.stringify({ type: "pull", session: sessionName, fromSeq: ps.cursor }));

    // Safety net: if no response arrives, unstick the pull state
    clearTimeout(pullTimers.get(sessionName));
    pullTimers.set(sessionName, setTimeout(() => {
      const ps = pullStates.get(sessionName);
      if (ps?.pulling) {
        ps.pulling = false;
        // Retry the pull — server may have dropped our request
        sendPull(sessionName);
      }
    }, PULL_TIMEOUT_MS));
  }

  function initPullState(sessionName, cursor) {
    const existing = pullStates.get(sessionName);
    if (existing) {
      existing.cursor = cursor;
      existing.pulling = false;
      existing.writing = false;
      existing.pending = false;
    } else {
      pullStates.set(sessionName, { cursor, pulling: false, writing: false, pending: false });
    }
  }

  function clearPullStates(sessionName) {
    if (sessionName) {
      pullStates.delete(sessionName);
      clearTimeout(pullTimers.get(sessionName));
      pullTimers.delete(sessionName);
    } else {
      pullStates.clear();
      for (const t of pullTimers.values()) clearTimeout(t);
      pullTimers.clear();
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
        { type: 'seqClear' },
        { type: 'terminalReset' },
        { type: 'updateConnectionIndicator' },
        { type: 'invalidateSessions', name: msg.session },
        { type: 'scrollToBottomIfNeeded', condition: !currentState.scroll.userScrolledUpBeforeDisconnect },
        { type: 'syncCarouselSubscriptions' }
      ]
    }),

    switched: (msg) => ({
      stateUpdates: {
        'connection.attached': true,
        'session.name': msg.session,
      },
      effects: [
        { type: 'seqClear' },
        { type: 'clearSubscriptions' },
        // No terminalReset — the terminal pool keeps each session's xterm
        // intact. Resetting here causes a flicker (blank frame between
        // clear and snapshot write). The output message writes the snapshot
        // to the correct session's terminal via getOutputTerm(session).
        { type: 'invalidateSessions', name: msg.session },
        { type: 'scrollToBottomIfNeeded', condition: true },
        { type: 'syncCarouselSubscriptions' },
      ]
    }),

    'subscribed': (msg) => ({
      stateUpdates: {},
      effects: [
        // Reset this session's terminal before the snapshot arrives so
        // stale content from a previous subscribe doesn't remain.
        { type: 'terminalResetSession', session: msg.session },
      ]
    }),

    'unsubscribed': (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'seqClear', session: msg.session }
      ]
    }),

    // Unsequenced output (scrollback replay on attach/switch) — write directly
    output: (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'terminalWrite', data: msg.data, session: msg.session, preserveScroll: true, useOutputTerm: true }
      ]
    }),

    // Server notifies that new data is available for a session topic
    'data-available': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'dataAvailable', session: msg.session }]
    }),

    // Response to a pull request — contains data from cursor to head
    'pull-response': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'pullResponse', session: msg.session, data: msg.data, cursor: msg.cursor }]
    }),

    // Cursor was evicted — server sends a pane snapshot to recover
    'pull-snapshot': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'pullSnapshot', session: msg.session, data: msg.data, cursor: msg.cursor }]
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

    // CLI-driven UI actions
    'open-tab': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'openTab', session: msg.session }]
    }),

    'notification': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'showNotification', title: msg.title, message: msg.message }]
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

    // seq-init: server tells us where the log head is — initialize pull cursor
    'seq-init': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'pullInit', session: msg.session, seq: msg.seq }]
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
      case 'updateConnectionIndicator':
        if (deps.updateConnectionIndicator) deps.updateConnectionIndicator();
        break;
      case 'fit':
        if (deps.fit) requestAnimationFrame(() => deps.fit());
        break;
      case 'log':
        console.log(effect.message);
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
      case 'seqClear':
        clearPullStates(effect.session || null);
        break;
      case 'pullInit':
        if (effect.session) {
          initPullState(effect.session, effect.seq);
          sendPull(effect.session);
        }
        break;
      case 'clearSubscriptions':
        // Clear the dedup set so syncCarouselSubscriptions can re-subscribe
        // background tiles after a switch. Without this, the dedup blocks
        // re-subscribes and background tiles stop updating.
        subscribedSessions.clear();
        break;
      case 'dataAvailable': {
        // Server notifies new data — trigger pull if not already busy
        const ps = pullStates.get(effect.session);
        if (!ps) break; // not initialized yet
        if (ps.pulling || ps.writing) {
          ps.pending = true; // will pull again after current op completes
          break;
        }
        sendPull(effect.session);
        break;
      }
      case 'pullResponse': {
        const ps = pullStates.get(effect.session);
        if (!ps) break;
        ps.pulling = false;
        clearTimeout(pullTimers.get(effect.session));
        if (effect.data && effect.data.length > 0) {
          ps.writing = true;
          const term = getOutputTerm(effect.session);
          if (term) {
            // Safety: if xterm's write callback never fires (terminal hidden/disposed),
            // unstick after a timeout so pulls can resume.
            const writeTimeout = setTimeout(() => {
              if (ps.writing) {
                ps.writing = false;
                ps.cursor = effect.cursor;
                if (ps.pending) { ps.pending = false; sendPull(effect.session); }
              }
            }, 3000);

            terminalWriteWithScroll(term, effect.data, () => {
              clearTimeout(writeTimeout);
              ps.writing = false;
              ps.cursor = effect.cursor;
              if (ps.pending) {
                ps.pending = false;
                sendPull(effect.session);
              }
            });
          } else {
            ps.writing = false;
            ps.cursor = effect.cursor;
          }
        } else {
          // Already caught up
          ps.cursor = effect.cursor;
          if (ps.pending) {
            ps.pending = false;
            sendPull(effect.session);
          }
        }
        break;
      }
      case 'pullSnapshot': {
        // Cursor was evicted — reset terminal and write the snapshot
        const ps = pullStates.get(effect.session);
        if (!ps) break;
        ps.pulling = false;
        clearTimeout(pullTimers.get(effect.session));
        const term = getOutputTerm(effect.session);
        if (term) {
          term.clear();
          term.reset();
          ps.writing = true;
          const writeTimeout = setTimeout(() => {
            if (ps.writing) {
              ps.writing = false;
              ps.cursor = effect.cursor;
              if (ps.pending) { ps.pending = false; sendPull(effect.session); }
            }
          }, 3000);

          terminalWriteWithScroll(term, effect.data || "", () => {
            clearTimeout(writeTimeout);
            ps.writing = false;
            ps.cursor = effect.cursor;
            if (ps.pending) {
              ps.pending = false;
              sendPull(effect.session);
            }
          });
        } else {
          ps.cursor = effect.cursor;
        }
        break;
      }
      case 'terminalReset': {
        const term = getTerm();
        if (!term) break;
        term.clear();
        term.reset();
        break;
      }
      case 'terminalResetSession': {
        // Reset a specific session's terminal (used before subscribe snapshot
        // replay so stale content doesn't persist).
        const term = getOutputTerm(effect.session);
        if (!term) break;
        term.clear();
        term.reset();
        break;
      }
      case 'terminalWrite': {
        const term = effect.useOutputTerm ? getOutputTerm(effect.session) : getTerm();
        if (!term) break;
        terminalWriteWithScroll(term, effect.data);
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
      case 'syncCarouselSubscriptions':
        if (deps.syncCarouselSubscriptions) deps.syncCarouselSubscriptions();
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
        term.resize(effect.cols, effect.rows);
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
      // CLI-driven UI actions
      case 'openTab':
        if (deps.onOpenTab) deps.onOpenTab(effect.session);
        break;
      case 'showNotification':
        if (deps.onNotification) deps.onNotification(effect.title, effect.message);
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
      clearPullStates();
      subscribedSessions.clear();
      if (deps.updateConnectionIndicator) deps.updateConnectionIndicator();
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
    sendSubscribe(sessionName, cols, rows) {
      const ws = state.connection.ws;
      if (ws?.readyState === 1 && !subscribedSessions.has(sessionName)) {
        subscribedSessions.add(sessionName);
        const payload = { type: "subscribe", session: sessionName };
        if (cols && rows) { payload.cols = cols; payload.rows = rows; }
        ws.send(JSON.stringify(payload));
      }
    },
    sendUnsubscribe(sessionName) {
      subscribedSessions.delete(sessionName);
      const ws = state.connection.ws;
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: "unsubscribe", session: sessionName }));
      }
    },
  };
}
