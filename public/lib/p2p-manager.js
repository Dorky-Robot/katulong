/**
 * P2P Manager
 *
 * WebRTC DataChannel manager for low-latency terminal I/O.
 * Uses raw RTCPeerConnection (no SimplePeer) for compatibility with
 * node-datachannel polyfill on the server side.
 */

/**
 * Create P2P manager
 */
export function createP2PManager(config = {}) {
  const {
    onStateChange,
    onData,
    getWS,
    retryDelay = 3000,
    maxRetries = 3
  } = config;

  let pc = null;
  let dc = null;
  let connected = false;
  let retryTimer = 0;
  let retryCount = 0;
  let _gaveUp = false; // true after maxRetries exhausted
  let _attempting = false; // true while a connection attempt is in progress

  /**
   * Destroy current peer connection
   */
  function destroy() {
    clearTimeout(retryTimer);
    retryTimer = 0;
    _attempting = false;

    if (dc) {
      try { dc.close(); } catch { /* ignore */ }
      dc = null;
    }
    if (pc) {
      try { pc.close(); } catch { /* ignore */ }
      pc = null;
    }

    if (connected) {
      connected = false;
      if (onStateChange) {
        onStateChange({ connected: false, peer: null });
      }
    }
  }

  /**
   * Schedule retry attempt with exponential backoff.
   * Gives up after maxRetries consecutive failures.
   */
  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryCount++;
    if (retryCount > maxRetries) {
      if (!_gaveUp) {
        _gaveUp = true;
        console.log(`[P2P] Gave up after ${maxRetries} attempts — using WebSocket`);
      }
      return;
    }
    const delay = retryDelay * Math.pow(2, retryCount - 1); // 3s, 6s, 12s
    console.log(`[P2P] Retry ${retryCount}/${maxRetries} in ${delay}ms`);
    retryTimer = setTimeout(() => {
      const ws = getWS ? getWS() : null;
      if (!connected && ws?.readyState === 1) {
        create();
      }
    }, delay);
  }

  /**
   * Create new peer connection (initiator side)
   */
  async function create() {
    // Destroy existing connection
    destroy();
    if (_gaveUp) {
      console.log("[P2P] Previously gave up — skipping (use WebSocket)");
      return;
    }
    if (_attempting) {
      console.log("[P2P] Connection attempt already in progress — skipping");
      return;
    }

    const ws = getWS ? getWS() : null;
    if (!ws || ws.readyState !== 1) {
      console.warn("[P2P] WebSocket not ready");
      return;
    }

    _attempting = true;
    const newPC = new RTCPeerConnection({ iceServers: [] });
    pc = newPC;

    if (onStateChange) {
      onStateChange({ connected: false, peer: null });
    }

    // Create DataChannel (we are the initiator)
    const newDC = newPC.createDataChannel("katulong", { ordered: true });
    dc = newDC;

    // ICE candidate trickle
    newPC.onicecandidate = (event) => {
      if (!event.candidate) return;
      console.log("[P2P] Local candidate:", event.candidate.candidate);
      const currentWS = getWS ? getWS() : null;
      if (currentWS?.readyState === 1) {
        currentWS.send(JSON.stringify({
          type: "p2p-signal",
          data: { candidate: event.candidate.toJSON() }
        }));
      }
    };

    newPC.oniceconnectionstatechange = () => {
      console.log("[P2P] ICE connection state:", newPC.iceConnectionState);
      if (newPC.iceConnectionState === "failed" || newPC.iceConnectionState === "disconnected") {
        if (pc !== newPC) return; // stale
        console.log("[P2P] ICE failed/disconnected, cleaning up");
        destroy();
        scheduleRetry();
      }
    };

    newPC.onicegatheringstatechange = () => {
      console.log("[P2P] ICE gathering state:", newPC.iceGatheringState);
    };

    // DataChannel events
    newDC.onopen = () => {
      if (pc !== newPC) return; // stale
      clearTimeout(retryTimer);
      retryTimer = 0;
      retryCount = 0; // reset on success
      _gaveUp = false;
      _attempting = false;
      connected = true;
      console.log("[P2P] DataChannel connected");
      if (onStateChange) {
        onStateChange({ connected: true, peer: newDC });
      }
    };

    newDC.onmessage = (event) => {
      if (onData) {
        const str = typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data);
        onData(str);
      }
    };

    newDC.onclose = () => {
      if (pc !== newPC) return; // stale
      const wasConnected = connected;
      console.log("[P2P] DataChannel closed, using WS");
      connected = false;
      dc = null;
      pc = null;
      _attempting = false;
      if (onStateChange) {
        onStateChange({ connected: false, peer: null });
      }
      // Only retry if the channel was previously open (actual disconnect).
      // If it never opened (ICE failed), the ICE handler already scheduled retry.
      if (wasConnected) scheduleRetry();
    };

    newDC.onerror = (err) => {
      if (pc !== newPC) return; // stale
      console.warn("[P2P] DataChannel error:", err?.message || err);
      connected = false;
      dc = null;
      pc = null;
      if (onStateChange) {
        onStateChange({ connected: false, peer: null });
      }
      scheduleRetry();
    };

    // Create and send the offer
    try {
      const offer = await newPC.createOffer();
      await newPC.setLocalDescription(offer);
      console.log("[P2P] Signal: offer");
      const currentWS = getWS ? getWS() : null;
      if (currentWS?.readyState === 1) {
        currentWS.send(JSON.stringify({
          type: "p2p-signal",
          data: { type: offer.type, sdp: offer.sdp }
        }));
      } else {
        // WS closed between createOffer and send — clean up
        destroy();
        scheduleRetry();
        return;
      }
    } catch (err) {
      console.warn("[P2P] Failed to create offer:", err.message);
      destroy();
      scheduleRetry();
    }
  }

  /**
   * Handle signal data from server (answers and ICE candidates)
   */
  async function signal(data) {
    if (!pc) return;
    try {
      if (data.type === "answer") {
        console.log("[P2P] Signal: answer received");
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.candidate) {
        console.log("[P2P] Remote candidate:", data.candidate.candidate);
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.warn("[P2P] Signal error:", err.message);
    }
  }

  /**
   * Send data over DataChannel
   * Returns true if sent successfully
   */
  function send(data) {
    if (!connected || !dc || dc.readyState !== "open") return false;

    try {
      dc.send(data);
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
    return { connected, peer: dc };
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
