/**
 * Terminal Tile
 *
 * Adapts the existing terminalPool as a TilePrototype. Each instance wraps
 * a single terminal session. The pool continues to own xterm.js lifecycle,
 * LRU eviction, WebGL rendering, and pull-based output — this tile is a
 * thin adapter that speaks the tile interface.
 */

import { createSessionStatusWatcher } from "../session-status-watcher.js";
import { resolveSessionId } from "../api-client.js";
import { createTerminalStatusBar } from "./terminal-status-bar.js";

/**
 * Create the terminal tile factory. Call once at startup with shared deps,
 * then register the returned factory with the tile registry.
 *
 * @param {object} deps
 * @param {object} deps.terminalPool — the terminal pool instance
 * @returns {(options: { sessionName: string }) => TilePrototype}
 *
 * Note: this factory intentionally does NOT receive the carousel. The
 * previous `a carousel dep` lazy-getter (removed in Tier 1 T1a) was a
 * confession of circular wiring — the carousel creates the tile, then
 * the tile reached back up into the carousel to register a back face.
 * The replacement is `ctx.faceStack`, which the container (carousel)
 * hands to the tile at mount time. See docs/tile-clusters-design.md.
 */
export function createTerminalTileFactory(deps) {
  const { terminalPool } = deps;
  return function createTerminalTile({ sessionName }) {
    // Mutable: rename updates this via setSessionName(). Every method below
    // reads `currentSessionName` (not the destructured parameter) so that
    // rename, lookup, persistence, and pool calls all stay in sync.
    let currentSessionName = sessionName;
    let mounted = false;
    let container = null;
    let statusBar = null;
    let watcher = null;
    let watcherUnsubscribe = null;
    // `destroyed` guards against async callbacks landing after unmount.
    // The watcher has its own `destroyed` guard for its fetches; this
    // flag covers anything that could race against it (e.g. a status
    // event arriving after unmount).
    let destroyed = false;

    const tile = {
      type: "terminal",

      /** The session name this tile wraps (current — kept in sync on rename). */
      get sessionName() { return currentSessionName; },

      /** Update the session name after a tab rename. The carousel calls
       *  this from renameCard() so that subsequent lookups (findCard,
       *  serialize, etc.) see the new name instead of the original.
       *  The watcher polls by id and needs no update; the back tile
       *  still tracks the friendly name for display. */
      setSessionName(newName) {
        currentSessionName = newName;
      },

      mount(el) {
        container = el;
        destroyed = false;
        const entry = terminalPool.getOrCreate(currentSessionName);
        terminalPool.protect(currentSessionName);
        entry.container.style.display = "";
        el.appendChild(entry.container);
        mounted = true;

        // Warp-style bottom widget strip. Attached as a sibling of the
        // terminal pool entry so the pool's xterm lifecycle is untouched;
        // CSS anchors the bar to the bottom of the tile card.
        statusBar = createTerminalStatusBar();
        statusBar.mount(el);

        // ── Shared status watcher ──────────────────────────────────
        // Status polling is keyed on the immutable session id, not the
        // friendly name — the id is resolved asynchronously at mount
        // and doesn't change on rename. If resolution fails (session
        // was killed externally between persist and mount) the tile
        // stays in its "no status" baseline state; the status bar
        // simply stays hidden until a status event lands.
        resolveSessionId(currentSessionName).then((sessionId) => {
          if (destroyed) return;
          watcher = createSessionStatusWatcher({ sessionId });
          watcherUnsubscribe = watcher.subscribe((event) => {
            if (destroyed) return;
            if (event.status) statusBar?.updateFromStatus(event.status);
          });
          // Eager first poll so the bar lights up immediately instead
          // of waiting one full interval for the first pane snapshot.
          watcher.poll().catch(() => {});
        }).catch(() => { /* session missing — baseline state is fine */ });
      },

      unmount() {
        if (!mounted) return;
        destroyed = true;
        watcherUnsubscribe?.();
        watcherUnsubscribe = null;
        watcher?.destroy();
        watcher = null;
        statusBar?.unmount();
        statusBar = null;
        terminalPool.unprotect(currentSessionName);
        const entry = terminalPool.get(currentSessionName);
        if (entry) {
          entry.container.style.display = "none";
          // Move terminal pane back to pool parent so it isn't orphaned
          // when the card wrapper is removed from the DOM.
          if (entry.container.parentElement) {
            entry.container.remove();
          }
        }
        mounted = false;
        container = null;
      },

      focus() {
        const entry = terminalPool.get(currentSessionName);
        if (!entry) return;
        terminalPool.setActive(currentSessionName);
        terminalPool.attachControls(currentSessionName);
        entry.term.focus();
        this.resize();
      },

      blur() {
        // Terminal keeps running in the background — nothing to do.
      },

      resize() {
        terminalPool.scale(currentSessionName);
      },

      getTitle() {
        return currentSessionName;
      },

      getIcon() {
        return "terminal-window";
      },

      serialize() {
        return { type: "terminal", sessionName: currentSessionName };
      },
    };

    return tile;
  };
}
