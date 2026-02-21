/**
 * Input Sender
 *
 * Composable buffered input sender for terminal.
 * Batches input using requestAnimationFrame for better performance.
 */

/**
 * Create input sender
 */
export function createInputSender(options = {}) {
  const {
    getWebSocket
  } = options;

  let sendBuf = "";
  let sendTimer = 0;

  /**
   * Send input data to terminal (buffered)
   * Batches multiple calls into a single WebSocket message
   */
  function send(data) {
    sendBuf += data;

    if (!sendTimer) {
      sendTimer = requestAnimationFrame(() => {
        sendTimer = 0;

        if (!sendBuf) return;

        const payload = JSON.stringify({ type: "input", data: sendBuf });

        const ws = getWebSocket ? getWebSocket() : null;
        if (ws && ws.readyState === 1) {
          ws.send(payload);
        }

        sendBuf = "";
      });
    }
  }

  /**
   * Get current buffer contents (for debugging)
   */
  function getBuffer() {
    return sendBuf;
  }

  /**
   * Clear buffer and pending timer
   */
  function clear() {
    sendBuf = "";
    if (sendTimer) {
      cancelAnimationFrame(sendTimer);
      sendTimer = 0;
    }
  }

  return {
    send,
    getBuffer,
    clear
  };
}
