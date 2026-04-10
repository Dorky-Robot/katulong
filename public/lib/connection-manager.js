/**
 * Connection Manager — imperative shell that composes pure state machines
 * (connection-store, heartbeat-machine) with actual WebSocket transport,
 * timers, and DOM event listeners.
 *
 * This module owns the connection lifecycle: connect, disconnect, reconnect,
 * heartbeat, visibility-based reconnection, and online/offline handling.
 * It does NOT know about message routing (attached, output, etc.) — it just
 * calls onMessage(msg) and lets the caller (app.js) dispatch.
 *
 * It does NOT send the "attach" message — that's the caller's job via
 * onTransportReady or a store subscriber.
 */

import { createConnectionStore } from "./connection-store.js";
import { createTransportLayer } from "./transport-layer.js";
import * as heartbeat from "./heartbeat-machine.js";
import { basePath } from "./base-path.js";

// ─── Constants ──────────────────────────────────────────────────────
const BACKOFF_INITIAL    = 1000;
const BACKOFF_MAX        = 10000;
const BACKOFF_FACTOR     = 2;
const BACKGROUND_THRESHOLD = 5000; // 5s — after this long in background, force reconnect

/**
 * Create a connection manager.
 *
 * @param {object} opts
 * @param {() => string} opts.getSessionName — returns current session name
 * @param {(msg: object) => void} opts.onMessage — called for every parsed WS message
 * @param {(transport: object) => void} [opts.onTransportReady] — called when transport is first ready
 * @param {boolean} [opts.debug] — enable store debug logging
 * @returns {object} connection manager API
 */
export function createConnectionManager({
  getSessionName,
  onMessage,
  onTransportReady,
  debug = false,
}) {
  // ─── Internal state ─────────────────────────────────────────────
  const connectionStore = createConnectionStore({ debug });
  let heartbeatState    = heartbeat.create();
  let epoch             = 0;
  let transport         = null;
  let reconnectTimer    = null;
  let heartbeatTimer    = null;
  let pingTimer         = null;
  let backoffDelay      = BACKOFF_INITIAL;
  let backgroundedAt    = null;
  let disposed          = false;

  // DOM listeners stored for cleanup
  const domListeners    = [];

  // ─── Helpers ────────────────────────────────────────────────────

  /**
   * Wrap a callback so unexpected errors trigger a reconnect rather than
   * silently breaking the connection.
   */
  function safeCallback(fn) {
    return (...args) => {
      try {
        fn(...args);
      } catch (err) {
        console.error("[connection-manager] Unexpected error, restarting:", err);
        handleDisconnect();
      }
    };
  }

  /**
   * Build the WebSocket URL from the current page location, respecting
   * reverse-proxy base paths (same logic as websocket-connection.js).
   */
  function buildWsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsPath = basePath ? `${basePath}/stream` : "";
    return `${proto}//${location.host}${wsPath}`;
  }

  // ─── Heartbeat ──────────────────────────────────────────────────

  /**
   * Process effects returned by heartbeat pure functions.
   * Updates heartbeatState and executes side effects.
   */
  function processEffects(result) {
    heartbeatState = result.state;
    for (const effect of result.effects) {
      if (effect.type === "sendPing") {
        if (transport && transport.readyState === 1) {
          transport.send(JSON.stringify({ type: "ping" }));
        }
      } else if (effect.type === "timeout") {
        // Heartbeat timed out — connection is dead
        if (transport) {
          transport.close();
        }
        handleDisconnect();
      }
    }
  }

  function startHeartbeat() {
    stopHeartbeat();

    // Send pings at the heartbeat interval
    pingTimer = setInterval(() => {
      const result = heartbeat.sendPing(heartbeatState, Date.now());
      processEffects(result);
    }, heartbeat.INTERVAL_MS);

    // Tick every second to check for timeout
    heartbeatTimer = setInterval(() => {
      const result = heartbeat.tick(heartbeatState, Date.now());
      processEffects(result);
    }, 1000);
  }

  function stopHeartbeat() {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ─── Message handling ───────────────────────────────────────────

  function handleMessage(event) {
    const data = typeof event === "string" ? event : event.data;
    const msg = JSON.parse(data);

    if (msg.type === "pong") {
      const result = heartbeat.receivePong(heartbeatState, epoch);
      processEffects(result);
      return;
    }

    onMessage(msg);
  }

  // ─── Disconnect / reconnect ─────────────────────────────────────

  function handleDisconnect() {
    stopHeartbeat();

    if (transport) {
      transport.close();
      transport = null;
    }

    connectionStore.disconnected();

    // Schedule reconnect with exponential backoff
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffDelay);

    backoffDelay = Math.min(backoffDelay * BACKOFF_FACTOR, BACKOFF_MAX);
  }

  // ─── Public API ─────────────────────────────────────────────────

  function connect() {
    if (disposed) return;

    epoch += 1;
    const myEpoch = epoch;

    // Clear any pending reconnect
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    connectionStore.connecting();

    const ws = new WebSocket(buildWsUrl());

    ws.onopen = safeCallback(() => {
      // Stale guard — a newer connect() was called while we waited
      if (myEpoch !== epoch) {
        ws.close();
        return;
      }

      // Create transport layer wrapping this WebSocket
      transport = createTransportLayer(ws);
      transport.onmessage = safeCallback(handleMessage);

      // Transition store to ready
      connectionStore.ready(transport.transportType);

      // Reset heartbeat for this new connection
      const resetResult = heartbeat.reset(heartbeatState, epoch);
      heartbeatState = resetResult.state;
      startHeartbeat();

      // Notify caller that transport is ready
      if (onTransportReady) {
        onTransportReady(transport);
      }

      // Reset backoff on successful connection
      backoffDelay = BACKOFF_INITIAL;
    });

    ws.onclose = safeCallback(() => {
      if (myEpoch !== epoch) return;
      handleDisconnect();
    });

    ws.onerror = safeCallback(() => {
      if (myEpoch !== epoch) return;
      // onclose will fire after onerror — let it handle cleanup.
      // But close explicitly to ensure the transition happens.
      ws.close();
    });
  }

  function disconnect() {
    // Clear reconnect — intentional disconnect should not auto-reconnect
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    stopHeartbeat();

    if (transport) {
      transport.close();
      transport = null;
    }

    connectionStore.disconnected();
  }

  function reconnectNow() {
    if (disposed) return;

    // Clear any pending reconnect
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    backoffDelay = BACKOFF_INITIAL;
    connect();
  }

  function send(data) {
    if (transport && transport.readyState === 1) {
      transport.send(data);
    }
    // Silently drop if not connected — callers don't need to check
  }

  function subscribe(fn) {
    return connectionStore.subscribe(fn);
  }

  function getState() {
    return connectionStore.getState();
  }

  // ─── DOM event wiring ──────────────────────────────────────────

  function addDomListener(target, event, handler) {
    target.addEventListener(event, handler);
    domListeners.push({ target, event, handler });
  }

  function init() {
    addDomListener(window, "offline", () => {
      if (!disposed) disconnect();
    });

    addDomListener(window, "online", () => {
      if (!disposed) reconnectNow();
    });

    addDomListener(document, "visibilitychange", () => {
      if (disposed) return;

      if (document.hidden) {
        backgroundedAt = Date.now();
      } else {
        const elapsed = Date.now() - (backgroundedAt || Date.now());
        backgroundedAt = null;

        if (elapsed > BACKGROUND_THRESHOLD) {
          // Extended background — connection is likely stale, force reconnect
          disconnect();
          connect();
        } else {
          // Brief background — probe with an immediate heartbeat ping
          const result = heartbeat.sendPing(heartbeatState, Date.now());
          processEffects(result);
        }
      }
    });
  }

  function dispose() {
    disposed = true;
    disconnect();

    // Remove all DOM listeners
    for (const { target, event, handler } of domListeners) {
      target.removeEventListener(event, handler);
    }
    domListeners.length = 0;
  }

  // ─── Return public interface ───────────────────────────────────
  return {
    connect,
    disconnect,
    reconnectNow,
    send,
    subscribe,
    getState,
    init,
    dispose,
    get transport() {
      return transport;
    },
  };
}
