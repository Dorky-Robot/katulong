/**
 * Transport Layer
 *
 * Wraps WebSocket + optional WebRTC DataChannel behind a unified interface.
 * Only ONE transport carries data at a time. The switch is atomic — no gap,
 * no overlap. WebSocket stays alive for signaling even when DataChannel is
 * the active data transport.
 *
 * No imports — this is a pure ES module with zero dependencies.
 */

/**
 * Map DataChannel readyState strings to WebSocket-compatible numeric codes.
 * WebSocket uses numbers (0–3), DataChannel uses strings.
 */
const DC_STATE_MAP = {
  connecting: 0,
  open: 1,
  closing: 2,
  closed: 3,
};

/**
 * Create a transport layer that wraps WS and optional DC.
 *
 * @param {WebSocket} ws — WebSocket instance (must already exist)
 * @returns {object} transport layer with send(), readyState, transportType, etc.
 */
export function createTransportLayer(ws) {
  let dc = null;
  let activeTransport = "websocket";
  let messageHandler = null;
  let transportChangeHandler = null;

  // Wire WS onmessage to forward data messages when WS is the active transport
  function wsMessageForwarder(ev) {
    if (activeTransport === "websocket" && messageHandler) {
      messageHandler(ev);
    }
  }
  ws.addEventListener("message", wsMessageForwarder);

  function wireDataChannel(channel) {
    channel.onmessage = (ev) => {
      if (activeTransport === "datachannel" && messageHandler) {
        messageHandler(ev);
      }
    };
    channel.onclose = () => {
      if (activeTransport === "datachannel") {
        activeTransport = "websocket";
        dc = null;
        if (transportChangeHandler) transportChangeHandler("websocket");
      }
    };
    channel.onerror = () => {
      if (activeTransport === "datachannel") {
        activeTransport = "websocket";
        dc = null;
        if (transportChangeHandler) transportChangeHandler("websocket");
      }
    };
  }

  function unwireDataChannel(channel) {
    if (channel) {
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
    }
  }

  return {
    /**
     * Send data via the active transport.
     */
    send(data) {
      if (activeTransport === "datachannel" && dc) {
        dc.send(data);
      } else {
        ws.send(data);
      }
    },

    /**
     * Numeric readyState (0–3) mirroring the active transport.
     * DataChannel string states are mapped to numeric equivalents.
     */
    get readyState() {
      if (activeTransport === "datachannel" && dc) {
        return DC_STATE_MAP[dc.readyState] ?? 3;
      }
      return ws.readyState;
    },

    /**
     * Which transport is currently carrying data.
     */
    get transportType() {
      return activeTransport;
    },

    /**
     * Atomically switch to DataChannel for data transport.
     * WS stays alive for signaling.
     */
    upgradeToDataChannel(channel) {
      // Clean up any previous DC
      if (dc) {
        unwireDataChannel(dc);
      }
      dc = channel;
      activeTransport = "datachannel";
      wireDataChannel(dc);
    },

    /**
     * Fall back to WebSocket for data transport.
     */
    downgradeToWebSocket() {
      if (dc) {
        unwireDataChannel(dc);
      }
      dc = null;
      activeTransport = "websocket";
    },

    /**
     * Set the onmessage handler. Receives MessageEvent from the active transport.
     */
    set onmessage(handler) {
      messageHandler = handler;
    },

    get onmessage() {
      return messageHandler;
    },

    set ontransportchange(handler) {
      transportChangeHandler = handler;
    },

    /**
     * Close both transports.
     */
    close() {
      if (dc) {
        dc.close();
        unwireDataChannel(dc);
        dc = null;
      }
      ws.removeEventListener("message", wsMessageForwarder);
      ws.close();
      activeTransport = "websocket";
    },

    /**
     * Always available for signaling, regardless of active transport.
     */
    get ws() {
      return ws;
    },
  };
}
