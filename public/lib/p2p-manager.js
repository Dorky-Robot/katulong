/**
 * P2P Manager
 *
 * WebRTC DataChannel manager for low-latency terminal I/O.
 * Uses SimplePeer for peer connection management.
 */

/**
 * Create P2P manager
 */
export function createP2PManager(config = {}) {
  const {
    onStateChange,
    onData,
    getWS,
    retryDelay = 3000
  } = config;

  let peer = null;
  let connected = false;
  let retryTimer = 0;

  /**
   * Destroy current peer connection
   */
  function destroy() {
    clearTimeout(retryTimer);
    retryTimer = 0;

    if (peer) {
      try {
        peer.destroy();
      } catch (err) {
        // Ignore errors during cleanup
      }
      peer = null;
    }

    if (connected) {
      connected = false;
      if (onStateChange) {
        onStateChange({ connected: false, peer: null });
      }
    }
  }

  /**
   * Schedule retry attempt
   */
  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      const ws = getWS ? getWS() : null;
      if (!connected && ws?.readyState === 1) {
        create();
      }
    }, retryDelay);
  }

  /**
   * Create new peer connection
   */
  function create() {
    // Check if SimplePeer is loaded
    if (typeof SimplePeer === "undefined") {
      console.warn("[P2P] SimplePeer not loaded");
      return;
    }

    // Destroy existing connection
    destroy();

    const ws = getWS ? getWS() : null;
    if (!ws || ws.readyState !== 1) {
      console.warn("[P2P] WebSocket not ready");
      return;
    }

    // Create new peer (initiator)
    const newPeer = new SimplePeer({
      initiator: true,
      trickle: true,
      config: { iceServers: [] } // Local network only
    });

    // Handle signaling
    newPeer.on("signal", (data) => {
      const currentWS = getWS ? getWS() : null;
      if (currentWS?.readyState === 1) {
        currentWS.send(JSON.stringify({ type: "p2p-signal", data }));
      }
    });

    // Handle connection
    newPeer.on("connect", () => {
      connected = true;
      console.log("[P2P] DataChannel connected");
      if (onStateChange) {
        onStateChange({ connected: true, peer: newPeer });
      }
    });

    // Handle incoming data
    newPeer.on("data", (chunk) => {
      const str = typeof chunk === "string"
        ? chunk
        : new TextDecoder().decode(chunk);
      if (onData) onData(str);
    });

    // Handle close
    newPeer.on("close", () => {
      console.log("[P2P] DataChannel closed, using WS");
      connected = false;
      peer = null;
      if (onStateChange) {
        onStateChange({ connected: false, peer: null });
      }
      scheduleRetry();
    });

    // Handle errors
    newPeer.on("error", (err) => {
      console.warn("[P2P] error:", err.message);
      connected = false;
      peer = null;
      if (onStateChange) {
        onStateChange({ connected: false, peer: null });
      }
      scheduleRetry();
    });

    peer = newPeer;
    if (onStateChange) {
      onStateChange({ connected: false, peer: newPeer });
    }
  }

  /**
   * Send signal data to peer
   */
  function signal(data) {
    if (peer) {
      peer.signal(data);
    }
  }

  /**
   * Send data over DataChannel
   * Returns true if sent successfully
   */
  function send(data) {
    if (!connected || !peer) return false;

    try {
      peer.send(data);
      return true;
    } catch (err) {
      console.warn("[P2P] Send failed:", err.message);
      return false;
    }
  }

  /**
   * Get current P2P state
   */
  function getState() {
    return { connected, peer };
  }

  return {
    create,
    destroy,
    signal,
    send,
    getState,
    scheduleRetry
  };
}

/**
 * Create P2P UI indicator updater
 */
export function createP2PIndicator(options = {}) {
  const {
    p2pManager,
    getConnectionState,
    indicatorId = "p2p-indicator"
  } = options;

  function update() {
    const dot = document.getElementById(indicatorId);
    if (!dot) return;

    const p2pState = p2pManager ? p2pManager.getState() : { connected: false };
    const connectionState = getConnectionState ? getConnectionState() : {};
    const attached = connectionState.attached || false;

    dot.classList.toggle("p2p-active", p2pState.connected);
    dot.classList.toggle("p2p-relay", attached && !p2pState.connected);

    dot.title = p2pState.connected
      ? "Connected (direct)"
      : attached
        ? "Connected (relay)"
        : "Disconnected";
  }

  return {
    update
  };
}
