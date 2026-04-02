/**
 * Client Transport Abstraction
 *
 * Per-client wrapper that routes data through whichever transport is active
 * (WebSocket or WebRTC DataChannel). Only ONE transport carries data at a
 * time. The WebSocket always stays alive for signaling even when DataChannel
 * is the active data transport.
 *
 * This abstraction exists so that ws-manager.js (and the rest of the server)
 * can call transport.send() without caring whether the client is connected
 * via WebSocket or DataChannel. It eliminates dual-path sequencing bugs —
 * the transport object owns the routing decision atomically.
 *
 * DataChannel uses the browser RTCDataChannel interface (onmessage, onclose,
 * onerror callback properties). WebSocket uses the `ws` library interface
 * (EventEmitter-style on/off).
 */

/**
 * Create a client transport wrapping an initial WebSocket connection.
 *
 * @param {import('ws').WebSocket} ws - The WebSocket connection (always kept alive)
 * @returns {object} Transport API
 */
export function createClientTransport(ws) {
  /** @type {'websocket' | 'datachannel'} */
  let activeType = "websocket";

  /** @type {RTCDataChannel | null} */
  let dc = null;

  // Event listeners registered by callers via on()/off().
  // Map<eventName, Set<handler>>
  const listeners = new Map();

  // Internal WS handlers that we attach/detach as transport switches.
  // We need references so we can remove them with off().
  const wsMessageHandler = (data) => {
    if (activeType === "websocket") emit("message", data);
  };
  const wsCloseHandler = (...args) => emit("close", ...args);
  const wsErrorHandler = (...args) => emit("error", ...args);

  // Wire up WS events immediately (WS is always the initial transport).
  ws.on("message", wsMessageHandler);
  ws.on("close", wsCloseHandler);
  ws.on("error", wsErrorHandler);

  function emit(event, ...args) {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of set) handler(...args);
  }

  /**
   * Attach DataChannel event handlers and auto-downgrade on close/error.
   */
  function wireDcEvents(dataChannel) {
    dataChannel.onmessage = (event) => {
      if (activeType === "datachannel") emit("message", event.data);
    };
    dataChannel.onclose = () => {
      if (activeType === "datachannel") {
        activeType = "websocket";
        dc = null;
      }
    };
    dataChannel.onerror = () => {
      if (activeType === "datachannel") {
        activeType = "websocket";
        dc = null;
      }
    };
  }

  /**
   * Detach DataChannel event handlers.
   */
  function unwireDcEvents(dataChannel) {
    if (!dataChannel) return;
    dataChannel.onmessage = null;
    dataChannel.onclose = null;
    dataChannel.onerror = null;
  }

  return {
    /**
     * Send data via the active transport.
     * @param {string|Buffer} data
     */
    send(data) {
      if (activeType === "datachannel" && dc) {
        dc.send(data);
      } else {
        ws.send(data);
      }
    },

    /**
     * Close the active transport.
     * If DataChannel is active, only the DataChannel is closed — the
     * WebSocket stays alive for signaling. If WebSocket is the active
     * transport, the WebSocket is closed.
     *
     * @param {number} [code]
     * @param {string} [reason]
     */
    close(code, reason) {
      if (activeType === "datachannel" && dc) {
        dc.close();
      } else {
        ws.close(code, reason);
      }
    },

    /** readyState of the active transport. */
    get readyState() {
      if (activeType === "datachannel" && dc) return dc.readyState;
      return ws.readyState;
    },

    /** Which transport is currently active: 'websocket' or 'datachannel'. */
    get transportType() {
      return activeType;
    },

    /** bufferedAmount of the active transport (for backpressure detection). */
    get bufferedAmount() {
      if (activeType === "datachannel" && dc) return dc.bufferedAmount;
      return ws.bufferedAmount;
    },

    /**
     * Atomically switch data flow to a DataChannel.
     * The WebSocket remains alive for signaling.
     *
     * @param {RTCDataChannel} dataChannel
     */
    upgradeToDataChannel(dataChannel) {
      dc = dataChannel;
      activeType = "datachannel";
      wireDcEvents(dc);
    },

    /**
     * Atomically fall back to WebSocket for data flow.
     * Detaches DataChannel event handlers and clears the reference.
     */
    downgradeToWebSocket() {
      if (activeType === "websocket") return;
      unwireDcEvents(dc);
      dc = null;
      activeType = "websocket";
    },

    /** The underlying WebSocket (always available, even during DC mode). */
    get ws() {
      return ws;
    },

    /**
     * Register an event handler.
     * Supported events: 'message', 'close', 'error'
     *
     * @param {string} event
     * @param {Function} handler
     */
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },

    /**
     * Remove an event handler.
     *
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
      const set = listeners.get(event);
      if (set) set.delete(handler);
    },
  };
}
