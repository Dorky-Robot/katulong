/**
 * WebSocket Connection Manager
 *
 * Handles WebSocket connection lifecycle, message routing, and effects.
 * Uses functional core / imperative shell pattern with dependency injection.
 */

import { scrollToBottom, terminalWriteWithScroll, isAtBottom } from "/lib/scroll-utils.js";
import { basePath } from "/lib/base-path.js";
import { DEFAULT_COLS, TERMINAL_ROWS_DEFAULT } from "/lib/terminal-config.js";
import { createTransportLayer } from "/lib/transport-layer.js";
import { createWebRTCPeer } from "/lib/webrtc-peer.js";

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
  let transport = null;  // TransportLayer wrapping WS + optional DataChannel
  let rtcPeer = null;    // WebRTC peer for DataChannel negotiation

  // --- Pure WebSocket message handlers (functional core) ---
  //
  // Raptor 3: the client is a passive viewer. The server is the sole
  // authority on terminal state — its ScreenState is the single source
  // of truth. Three message types drive every client-visible change:
  //   - `output`  — raw bytes while dims are stable; write through.
  //   - `snapshot` — atomic dim transition: resize → clear → write.
  //   - `attached`/`switched`/`subscribed` — carry an initial snapshot
  //     the client applies before any subsequent `output` arrives.
  // There is no pull path, no drift detection, no fingerprint check,
  // and no sequence-number plumbing. Every garble class tracked down
  // in Raptor 1/2 traced back to "bytes emitted at dims A applied to
  // a buffer at dims B" — Raptor 3 deletes the possibility.
  const wsMessageHandlers = {
    // Initial attach — carries dims + serialized screen for the attached
    // session. Apply atomically: resize → clear → write. From this moment
    // onward, every `output` message for this session is guaranteed to be
    // at the snapshot's dims (the server serializes output-after-resize
    // on its end), and every subsequent dim change arrives as a `snapshot`.
    attached: (msg, currentState) => ({
      stateUpdates: {
        'connection.attached': true,
        'session.name': msg.session,
        'scroll.userScrolledUpBeforeDisconnect': false
      },
      effects: [
        { type: 'applySnapshot', session: msg.session, cols: msg.cols, rows: msg.rows, data: msg.data || "" },
        { type: 'updateConnectionIndicator' },
        { type: 'invalidateSessions', name: msg.session },
        { type: 'scrollToBottomIfNeeded', condition: !currentState.scroll.userScrolledUpBeforeDisconnect },
        { type: 'syncCarouselSubscriptions' }
      ]
    }),

    // Foreground a session already subscribed in the background. Apply
    // the snapshot authoritatively so the client's xterm matches the
    // server regardless of whatever dim or content drift accumulated
    // while this session was offscreen.
    switched: (msg) => ({
      stateUpdates: {
        'connection.attached': true,
        'session.name': msg.session,
      },
      effects: [
        { type: 'applySnapshot', session: msg.session, cols: msg.cols, rows: msg.rows, data: msg.data || "" },
        { type: 'invalidateSessions', name: msg.session },
        { type: 'scrollToBottomIfNeeded', condition: true },
        { type: 'syncCarouselSubscriptions' },
      ]
    }),

    // View-only subscribe (carousel card, background tab). The server
    // does NOT resize tmux for a subscribe — the snapshot carries the
    // session's current dims, which the client adopts for its local xterm.
    'subscribed': (msg) => ({
      stateUpdates: {},
      effects: [
        { type: 'applySnapshot', session: msg.session, cols: msg.cols, rows: msg.rows, data: msg.data || "" },
      ]
    }),

    'unsubscribed': () => ({
      stateUpdates: {},
      effects: []
    }),

    // Raw bytes emitted by tmux at the current session dims. Stream
    // straight to the target terminal — no sequence number, no cursor
    // tracking, no drift check. Ordering inside a single session is
    // preserved by the server's per-session coalescer, and dim stability
    // is guaranteed because any resize interleaves a `snapshot` message
    // through the same per-session bridge topic.
    'output': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'output', session: msg.session, data: msg.data }]
    }),

    // Atomic dim transition — the server resized tmux, reserialized its
    // headless mirror, and is now handing us the ground truth for this
    // session. Apply resize → clear → write so the next `output` byte
    // lands on the new grid.
    'snapshot': (msg) => ({
      stateUpdates: {},
      effects: [{ type: 'applySnapshot', session: msg.session, cols: msg.cols, rows: msg.rows, data: msg.data || "" }]
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
    // Raw byte relay. Raptor 3 guarantees these bytes are at the current
    // session dims — any resize arrived first as a `snapshot` message
    // through the same bridge topic, so write-through is safe.
    output: (e) => {
      const t = getOutputTerm(e.session);
      if (t) terminalWriteWithScroll(t, e.data);
    },
    // Atomic dim transition + ground-truth replay. Used on attach,
    // subscribe, switch, and any mid-session resize. Resizes the
    // xterm to the server's dims, clears the buffer/scrollback, then
    // writes the serialized screen. The critical invariant: no `output`
    // byte for this session is processed between the resize and the
    // write, because wsMessageHandlers run serially per message and
    // `snapshot` includes the entire new-grid content inline.
    applySnapshot: (e) => {
      const t = getOutputTerm(e.session);
      if (!t) return;
      if (e.cols && e.rows && (t.cols !== e.cols || t.rows !== e.rows)) {
        t.resize(e.cols, e.rows);
      }
      // clear() wipes scrollback; reset() restores the parser to a
      // known state so stale DEC private modes don't bleed through.
      t.clear();
      t.reset();
      if (e.data) terminalWriteWithScroll(t, e.data);
    },
    reload: () => location.reload(),
    invalidateSessions: (e) => deps.invalidateSessions?.(e.name),
    updateSessionUI: (e) => deps.updateSessionUI?.(e.name),
    syncCarouselSubscriptions: () => deps.syncCarouselSubscriptions?.(),
    refreshTokensAfterRegistration: () => deps.refreshTokensAfterRegistration?.(),
    sessionRemoved: (e) => deps.onSessionRemoved?.(e.name),
    poolRename: (e) => deps.poolRename?.(e.oldName, e.newName),
    tabRename: (e) => deps.tabRename?.(e.oldName, e.newName),
    terminalWrite: (e) => {
      // Legacy escape hatch used only by the `exit` handler to paint
      // `[shell exited]` into whatever terminal is on screen.
      const t = e.useOutputTerm ? getOutputTerm(e.session) : getTerm();
      if (t) terminalWriteWithScroll(t, e.data);
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
    const ws = new WebSocket(`${proto}//${location.host}${wsPath}`);
    state.connection.ws = ws;

    // Wrap the WebSocket in a transport layer — all data send/receive goes
    // through transport.send() which routes to WS or DataChannel atomically.
    transport = createTransportLayer(ws);
    state.connection.transport = transport;

    ws.onopen = () => {
      connectionState = CONNECTION_STATES.CONNECTED;
      state.connection.reconnectDelay = 1000;
      state.connection.transportType = "websocket";
      const term = getTerm();
      const cols = term?.cols || DEFAULT_COLS;
      const rows = term?.rows || TERMINAL_ROWS_DEFAULT;
      // All data goes through the transport abstraction — it routes to
      // WS when DC doesn't exist and to DC after upgrade. Keeping the
      // application layer free of `ws.send` preserves the invariant that
      // message ordering is the transport's concern, not ours.
      transport.send(JSON.stringify({ type: "attach", session: state.session.name, cols, rows }));
    };

    // Messages arrive via the transport layer (active channel — WS or DC).
    transport.onmessage = (e) => {
      const data = typeof e === "string" ? e : e.data;
      const msg = JSON.parse(data);

      // Handle WebRTC signaling messages (always over WS, before handler lookup)
      if (msg.type === "rtc-answer" && rtcPeer) {
        rtcPeer.handleAnswer(msg.sdp);
        return;
      }
      if (msg.type === "rtc-ice-candidate" && rtcPeer) {
        rtcPeer.handleCandidate(msg.candidate);
        return;
      }

      const handler = wsMessageHandlers[msg.type];

      if (handler) {
        const { stateUpdates, effects } = handler(msg, state);

        // Transition to ATTACHED when server confirms attachment
        if (msg.type === 'attached' || msg.type === 'switched') {
          connectionState = CONNECTION_STATES.ATTACHED;
          // Attempt WebRTC upgrade after attach for lower latency
          initiateWebRTC();
        }

        // Apply state updates
        if (Object.keys(stateUpdates).length > 0) {
          state.updateMany(stateUpdates);
        }

        // Execute effects
        effects.forEach(executeEffect);
      }
    };

    ws.onclose = (event) => {
      connectionState = CONNECTION_STATES.DISCONNECTED;

      // Clean up WebRTC peer on disconnect
      if (rtcPeer) { rtcPeer.close(); rtcPeer = null; }
      transport = null;
      state.connection.transport = null;
      state.connection.transportType = null;

      // Check if connection was closed due to revoked credentials
      if (event.code === 1008) { // 1008 = Policy Violation
        window.location.href = '/login?reason=revoked';
        return;
      }

      // Normal disconnect - attempt reconnection with exponential backoff
      const term = getTerm();
      state.scroll.userScrolledUpBeforeDisconnect = term ? !isAtBottom(term) : false;
      state.connection.attached = false;
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

    ws.onerror = () => {
      connectionState = CONNECTION_STATES.DISCONNECTED;
      ws.close();
    };
  }

  /**
   * Attempt WebRTC DataChannel upgrade after successful WS attach.
   * If RTCPeerConnection is not available (e.g., older browser), this is a no-op.
   * On success, transport layer switches to DataChannel atomically.
   * On failure, stays on WebSocket — no user-visible impact.
   */
  function initiateWebRTC() {
    if (typeof RTCPeerConnection === "undefined") return;
    if (rtcPeer) { rtcPeer.close(); rtcPeer = null; }

    rtcPeer = createWebRTCPeer({
      sendSignaling: (msg) => {
        // Signaling always goes over WebSocket (DC doesn't exist yet)
        const ws = state.connection.ws;
        if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
      },
      onDataChannel: (dc) => {
        if (transport) {
          transport.upgradeToDataChannel(dc);
          state.connection.transportType = "datachannel";
          if (deps.updateConnectionIndicator) deps.updateConnectionIndicator();
          console.log("[WebRTC] Upgraded to DataChannel (P2P)");
        }
      },
      onStateChange: (s) => {
        if (s === "failed" || s === "closed") {
          // DataChannel failed or closed — transport auto-downgrades to WS
          if (state.connection.transportType === "datachannel") {
            state.connection.transportType = "websocket";
            if (deps.updateConnectionIndicator) deps.updateConnectionIndicator();
            console.log("[WebRTC] Fell back to WebSocket");
          }
        }
      },
    });

    rtcPeer.connect();
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

        // Force reconnect after extended backgrounding to get fresh state.
        // Closing the underlying WS is deliberate — the WS is the signaling
        // channel, and closing it also tears down the DataChannel via
        // transport's onclose path, giving us a clean reconnect.
        if (hiddenDuration > 5000 && state.connection.ws) {
          state.connection.ws.close();
        } else if (transport && transport.readyState === 1) {
          // Brief background — ping with resize to verify the active
          // transport (WS or DC) still carries data end-to-end.
          try {
            const term = getTerm();
            const cols = term?.cols || DEFAULT_COLS;
            const rows = term?.rows || TERMINAL_ROWS_DEFAULT;
            transport.send(JSON.stringify({ type: "resize", session: state.session.name, cols, rows }));
          } catch {
            if (state.connection.ws) state.connection.ws.close();
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
    sendSubscribe(sessionName) {
      // Raptor 3: subscribe is view-only and never resizes tmux, so
      // cols/rows from the caller are ignored — the server sends back
      // a `subscribed` message whose snapshot carries the session's
      // current dims for the client to adopt.
      if (transport?.readyState === 1) {
        transport.send(JSON.stringify({ type: "subscribe", session: sessionName }));
      }
    },
    sendUnsubscribe(sessionName) {
      if (transport?.readyState === 1) {
        transport.send(JSON.stringify({ type: "unsubscribe", session: sessionName }));
      }
    },
    /** Current transport type for connection indicator */
    getTransportType: () => state.connection.transportType || null,
  };
}
