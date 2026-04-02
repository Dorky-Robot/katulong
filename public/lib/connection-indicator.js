/**
 * Connection indicator state computation.
 *
 * Three-state model for the WebRTC transport layer:
 *   - Grey  (cssClass '')       — disconnected
 *   - Yellow (cssClass 'relay')  — data flowing through WebSocket tunnel
 *   - Green  (cssClass 'direct') — P2P DataChannel (LAN / direct connection)
 *
 * This pure function is extracted from the DOM-coupled updateConnectionIndicator()
 * in app.js so the logic can be unit-tested without a browser environment.
 */

/**
 * Compute the CSS class and title text for the connection indicator dots.
 *
 * @param {boolean} attached  — whether the terminal session is connected
 * @param {string|null|undefined} transportType — 'websocket', 'datachannel', or nullish
 * @returns {{ cssClass: string, title: string }}
 */
export function computeIndicatorState(attached, transportType) {
  if (!attached) {
    return { cssClass: "", title: "Disconnected" };
  }
  if (transportType === "datachannel") {
    return { cssClass: "direct", title: "Direct (P2P)" };
  }
  return { cssClass: "relay", title: "Relay (WebSocket)" };
}
