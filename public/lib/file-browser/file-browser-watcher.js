/**
 * File Browser Watcher — live filesystem sync via SSE.
 *
 * Opens an EventSource to /api/files/watch with the current column
 * paths. When the server detects a change via fs.watch, it sends an
 * SSE event and we call nav.refreshAll(). The connection is torn down
 * and re-opened when the set of watched paths changes.
 *
 * Replaces the manual refresh button — the view stays in sync
 * automatically as long as the connection is open.
 */

const REFRESH_DEBOUNCE_MS = 400;

/**
 * @param {object} nav — navigation controller
 * @param {object} store — file-browser store
 * @returns {{ sync: () => void, stop: () => void }}
 */
export function createFileWatcher(nav, store) {
  let eventSource = null;
  let currentKey = "";
  let debounceTimer = null;

  /** (Re-)open the SSE connection for the current column paths. */
  function sync() {
    const paths = store.getState().columns
      .map(c => c.path)
      .filter(Boolean);
    const key = paths.join(",");

    // Same set of paths — nothing to do
    if (key === currentKey && eventSource?.readyState !== EventSource.CLOSED) return;
    currentKey = key;

    // Tear down previous connection
    if (eventSource) eventSource.close();
    eventSource = null;

    if (paths.length === 0) return;

    const url = `/api/files/watch?paths=${encodeURIComponent(key)}`;
    eventSource = new EventSource(url);

    eventSource.onmessage = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => nav.refreshAll(), REFRESH_DEBOUNCE_MS);
    };
  }

  function stop() {
    if (eventSource) eventSource.close();
    eventSource = null;
    currentKey = "";
    clearTimeout(debounceTimer);
  }

  return { sync, stop };
}
