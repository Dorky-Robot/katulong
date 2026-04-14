/**
 * Document Watcher — live file-sync for document-tile via SSE.
 *
 * Opens an EventSource to /api/files/watch for a single file path.
 * When the server emits a change event, invokes onChange. The server
 * already debounces, so we fire straight through.
 *
 * Mirrors the pattern in file-browser-watcher.js; factored out so
 * document-tile.js can be wired for live reload without growing more
 * inline fetch/watch plumbing, and so the behaviour is unit-testable.
 */

/**
 * @param {object} opts
 * @param {string} opts.filePath — path to watch
 * @param {() => void} opts.onChange — called on each change notification
 * @param {typeof EventSource} [opts.EventSourceImpl] — injectable for tests
 * @returns {{ stop: () => void }}
 */
export function createDocumentWatcher({ filePath, onChange, EventSourceImpl }) {
  const Impl = EventSourceImpl || globalThis.EventSource;
  if (!filePath || typeof Impl !== "function") {
    return { stop() {} };
  }

  const url = `/api/files/watch?paths=${encodeURIComponent(filePath)}`;
  const es = new Impl(url);
  es.onmessage = () => { try { onChange(); } catch { /* swallow */ } };

  return {
    stop() {
      try { es.close(); } catch { /* already closed */ }
    },
  };
}
