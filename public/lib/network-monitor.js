/**
 * Network Monitor
 *
 * Composable network change detection.
 */

/**
 * Create network monitor
 */
export function createNetworkMonitor(options = {}) {
  const {
    onNetworkChange
  } = options;

  /**
   * Handle network change event
   */
  function handleNetworkChange() {
    if (onNetworkChange) {
      onNetworkChange();
    }
  }

  /**
   * Initialize network monitor
   */
  function init() {
    window.addEventListener("online", handleNetworkChange);

    // Network Information API (optional, not supported in all browsers)
    if (navigator.connection) {
      navigator.connection.addEventListener("change", handleNetworkChange);
    }
  }

  /**
   * Cleanup
   */
  function unmount() {
    window.removeEventListener("online", handleNetworkChange);

    if (navigator.connection) {
      navigator.connection.removeEventListener("change", handleNetworkChange);
    }
  }

  return {
    init,
    unmount
  };
}
