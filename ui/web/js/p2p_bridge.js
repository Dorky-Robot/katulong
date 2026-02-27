/**
 * P2P Bridge for Dart interop
 *
 * Wraps simple-peer for WebRTC DataChannel connections.
 * Expects SimplePeer to be loaded globally from /vendor/simple-peer/simplepeer.min.js.
 */
(function () {
  'use strict';

  let peer = null;
  let callbacks = {};

  const bridge = {
    /**
     * Create a new peer connection.
     * @param {boolean} initiator - Whether this peer is the initiator
     */
    create(initiator) {
      if (!window.SimplePeer) {
        console.warn('[p2p_bridge] SimplePeer not loaded');
        return;
      }

      bridge.destroy();

      peer = new window.SimplePeer({ initiator, trickle: true });

      peer.on('signal', (data) => {
        if (callbacks.onSignal) callbacks.onSignal(JSON.stringify(data));
      });

      peer.on('connect', () => {
        if (callbacks.onConnect) callbacks.onConnect();
      });

      peer.on('data', (data) => {
        if (callbacks.onData) callbacks.onData(data.toString());
      });

      peer.on('close', () => {
        if (callbacks.onClose) callbacks.onClose();
        peer = null;
      });

      peer.on('error', (err) => {
        console.warn('[p2p_bridge] Peer error:', err.message);
        if (callbacks.onError) callbacks.onError(err.message);
      });
    },

    /**
     * Signal the peer with SDP/ICE data.
     * @param {string} dataJSON - JSON string of signaling data
     */
    signal(dataJSON) {
      if (peer) {
        try {
          peer.signal(JSON.parse(dataJSON));
        } catch (e) {
          console.warn('[p2p_bridge] Signal error:', e);
        }
      }
    },

    /**
     * Send data over the DataChannel.
     * @param {string} data - Data to send
     */
    send(data) {
      if (peer && peer.connected) {
        peer.send(data);
      }
    },

    /** Check if peer is connected. */
    isConnected() {
      return !!(peer && peer.connected);
    },

    /** Destroy the peer connection. */
    destroy() {
      if (peer) {
        peer.destroy();
        peer = null;
      }
    },

    /** Register event callbacks. */
    onSignal(cb) { callbacks.onSignal = cb; },
    onConnect(cb) { callbacks.onConnect = cb; },
    onData(cb) { callbacks.onData = cb; },
    onClose(cb) { callbacks.onClose = cb; },
    onError(cb) { callbacks.onError = cb; },
  };

  window.p2pBridge = bridge;
})();
