/**
 * P2P UI Indicator
 *
 * Composable P2P connection status indicator.
 */

/**
 * Create P2P UI indicator updater
 */
export function createP2PIndicator(options = {}) {
  const {
    p2pManager,
    getConnectionState,
    indicatorId = "p2p-indicator"
  } = options;

  /**
   * Update P2P indicator UI
   */
  function update() {
    const dot = document.getElementById(indicatorId);
    if (!dot) return;

    const p2pState = p2pManager ? p2pManager.getState() : { connected: false };
    const connectionState = getConnectionState ? getConnectionState() : {};
    const attached = connectionState.attached || false;

    // Update CSS classes
    dot.classList.toggle("p2p-active", p2pState.connected);
    dot.classList.toggle("p2p-relay", attached && !p2pState.connected);

    // Update title/tooltip
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
