/**
 * WebSocket Connection Manager
 *
 * Handles WebSocket connection lifecycle, message routing, and effects.
 * Uses functional core / imperative shell pattern with dependency injection.
 */

import { scrollToBottom, terminalWriteWithScroll, isAtBottom } from "/lib/scroll-utils.js";
import { basePath } from "/lib/base-path.js";
import { createPullManager } from "/lib/pull-manager.js";
import { screenFingerprint } from "/lib/screen-fingerprint.js";

/**
 * Connection state machine: DISCONNECTED → CONNECTING → CONNECTED → ATTACHED
 * Only valid transitions are forward through this sequence, or back to DISCONNECTED.
 */
const CONNECTION_STATES = {
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

  // --- Pull-based output ---
  // Extracted to pull-manager.js: pure state machine with callbacks.
  const pulls = createPullManager({
    onSendPull(session, fromSeq) {
      const ws = state.connection.ws;
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: "pull", session, fromSeq }));
      }
    },
    onWrite(session, data, done) {
      const term = getOutputTerm(session);
      if (term) {
        terminalWriteWithScroll(term, data, done);
      } else {
        // No terminal yet — reject the write so pull manager doesn't
        // advance the cursor. Data will be re-pulled when the terminal
        // is created and a data-available fires.
        done(false); // false = write rejected, don't advance cursor
      }
    },
    onReset(session) {
      const term = getOutputTerm(session);
      if (!term) return;
      // Clear screen + cursor home WITHOUT resetting terminal modes.
      // term.reset() nukes bracketed paste, application cursor, and
      // other DEC private modes that the shell/TUI enabled.  The
      // serialize snapshot doesn't restore all modes, so using
      // escape sequences to clear is less destructive.
      term.write("\x1b[2J\x1b[H");
      // Clear scrollback separately (escape sequence only clears screen)
      term.clear();
    },
  });

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
        ...(msg.data ? [{ type: 'terminalWrite', data: msg.data, session: msg.session, useOutputTerm: true }] : []),
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
        // No terminalReset — the terminal pool keeps each session's xterm
        // intact with its content. No snapshot replay either — the pull
        // mechanism resumes from the last known cursor and fills in any
        // output that arrived while we were away. This eliminates the
        // serialize snapshot (source of garble from mid-frame captures).
        { type: 'invalidateSessions', name: msg.session },
        { type: 'scrollToBottomIfNeeded', condition: true },
        { type: 'syncCarouselSubscriptions' },
      ]
    }),

    'subscribed': (msg) => ({
      stateUpdates: {},
      effects: [
        // Write snapshot only if the terminal is empty (fresh from pool
        // after page refresh). If the terminal already has content (tab
        // switch), skip to avoid mid-frame garble from serializeScreen.
        ...(msg.data ? [{ type: 'subscribeSnapshot', data: msg.data, session: msg.session }] : []),
      ]
    }),

    'unsubscribed': (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'seqClear', session: msg.session }
      ]
    }),

    // Server notifies that new data is available for a session topic
    'data-available': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'dataAvailable', session: msg.session }]
    }),

    // Server-pushed output — data sent inline, zero round trips
    'output': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'outputReceived', session: msg.session, data: msg.data, cursor: msg.cursor, fromSeq: msg.fromSeq }]
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

    'device-auth-request': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'showDeviceAuthRequest', requestId: msg.requestId, code: msg.code, userAgent: msg.userAgent }]
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

    // Drift detection: server sends screen fingerprint after output settles.
    // Client compares against its own xterm — on mismatch, request resync.
    'state-check': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'stateCheck', session: msg.session, fingerprint: msg.fingerprint }]
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

  // Effect handlers — data-driven lookup instead of switch.
  // Each handler receives the effect object.
  const effectHandlers = {
    updateConnectionIndicator: () => deps.updateConnectionIndicator?.(),
    fit: () => { if (deps.fit) requestAnimationFrame(() => deps.fit()); },
    log: (e) => console.log(e.message),
    pasteComplete: (e) => deps.onPasteComplete?.(e.path),
    scrollToBottomIfNeeded: (e) => { const t = getTerm(); if (e.condition && t) scrollToBottom(t); },
    seqClear: (e) => pulls.clear(e.session || null),
    pullInit: (e) => { if (e.session) pulls.init(e.session, e.seq); },
    dataAvailable: (e) => pulls.dataAvailable(e.session),
    outputReceived: (e) => pulls.outputReceived(e.session, e.data, e.cursor, e.fromSeq),
    pullResponse: (e) => pulls.pullResponse(e.session, e.data, e.cursor),
    pullSnapshot: (e) => pulls.pullSnapshot(e.session, e.data || "", e.cursor),
    stateCheck: (e) => {
      function check() {
        const ps = pulls.get(e.session);
        if (ps?.writing || ps?.pulling) return false; // can't check yet
        const term = getOutputTerm(e.session);
        if (!term) return true;
        const clientFp = screenFingerprint(term);
        if (clientFp !== e.fingerprint) {
          console.log(`[drift] session=${e.session} server=${e.fingerprint} client=${clientFp} — requesting resync`);
          const ws = state.connection.ws;
          if (ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: "resync", session: e.session }));
          }
        }
        return true;
      }
      // Retry if pull manager is busy — the idle timer fires once per
      // output burst, so skipping means garble persists forever.
      if (!check()) setTimeout(check, 300);
    },
    terminalReset: () => { const t = getTerm(); if (t) { t.clear(); t.reset(); } },
    terminalWrite: (e) => { const t = e.useOutputTerm ? getOutputTerm(e.session) : getTerm(); if (t) terminalWriteWithScroll(t, e.data); },
    subscribeSnapshot: (e) => {
      // Only write snapshot if the terminal is empty (fresh after page refresh).
      // If it already has content (tab switch), skip to avoid mid-frame garble.
      const t = getOutputTerm(e.session);
      if (!t) return;
      const buf = t.buffer?.active;
      const isEmpty = buf && buf.baseY === 0 && buf.cursorY === 0 && buf.cursorX === 0;
      if (isEmpty && e.data) {
        t.clear(); t.reset();
        terminalWriteWithScroll(t, e.data);
      }
    },
    reload: () => location.reload(),
    invalidateSessions: (e) => deps.invalidateSessions?.(e.name),
    updateSessionUI: (e) => deps.updateSessionUI?.(e.name),
    syncCarouselSubscriptions: () => deps.syncCarouselSubscriptions?.(),
    refreshTokensAfterRegistration: () => deps.refreshTokensAfterRegistration?.(),
    sessionRemoved: (e) => deps.onSessionRemoved?.(e.name),
    poolRename: (e) => deps.poolRename?.(e.oldName, e.newName),
    tabRename: (e) => deps.tabRename?.(e.oldName, e.newName),
    resizeSync: (e) => {
      const t = getTerm();
      if (t && e.cols > 0 && e.rows > 0 && e.cols <= 1000 && e.rows <= 1000) t.resize(e.cols, e.rows);
    },
    fastReconnect: () => {
      state.connection.reconnectDelay = 500;
      if (state.connection.ws?.readyState === WebSocket.OPEN) state.connection.ws.close();
    },
    helmModeChanged: (e) => deps.onHelmModeChanged?.(e),
    helmEvent: (e) => deps.onHelmEvent?.(e.session, e.event),
    helmTurnComplete: (e) => deps.onHelmTurnComplete?.(e.session),
    helmWaitingForInput: (e) => deps.onHelmWaitingForInput?.(e.session),
    tabIconChanged: (e) => deps.onTabIconChanged?.(e.session, e.icon),
    openTab: (e) => deps.onOpenTab?.(e.session),
    showNotification: (e) => deps.onNotification?.(e.title, e.message),
    showDeviceAuthRequest: (e) => deps.onDeviceAuthRequest?.(e.requestId, e.code, e.userAgent),
  };

  function executeEffect(effect) {
    const handler = effectHandlers[effect.type];
    if (handler) handler(effect);
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
      pulls.clear();
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
      if (ws?.readyState === 1) {
        const msg = { type: "subscribe", session: sessionName };
        if (cols) msg.cols = cols;
        if (rows) msg.rows = rows;
        ws.send(JSON.stringify(msg));
      }
    },
    sendUnsubscribe(sessionName) {
      const ws = state.connection.ws;
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: "unsubscribe", session: sessionName }));
      }
    },
  };
}
