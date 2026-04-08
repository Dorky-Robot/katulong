/**
 * Terminal Tile
 *
 * Adapts the existing terminalPool as a TilePrototype. Each instance wraps
 * a single terminal session. The pool continues to own xterm.js lifecycle,
 * LRU eviction, WebGL rendering, and pull-based output — this tile is a
 * thin adapter that speaks the tile interface.
 */

import { createDashboardBackTile } from "./dashboard-back-tile.js";
import { createSessionStatusWatcher } from "../session-status-watcher.js";

/**
 * Create the terminal tile factory. Call once at startup with shared deps,
 * then register the returned factory with the tile registry.
 *
 * @param {object} deps
 * @param {object} deps.terminalPool — the terminal pool instance
 * @param {object} [deps.carousel] — carousel instance (for setBackTile)
 * @returns {(options: { sessionName: string }) => TilePrototype}
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
    let backTile = null;
    let watcher = null;
    let watcherUnsubscribe = null;
    let autoFlipTimer = null;
    // `destroyed` guards against async callbacks landing after unmount.
    // The watcher has its own `destroyed` guard for its fetches, but the
    // 1.5s auto-flip debounce is owned by this tile and needs its own
    // guard so a timeout callback can't touch a stale carousel ref.
    let destroyed = false;

    const tile = {
      type: "terminal",

      /** The session name this tile wraps (current — kept in sync on rename). */
      get sessionName() { return currentSessionName; },

      /** Update the session name after a tab rename. The carousel calls
       *  this from renameCard() so that subsequent lookups (findCard,
       *  serialize, etc.) see the new name instead of the original. */
      setSessionName(newName) {
        currentSessionName = newName;
        watcher?.setSessionName(newName);
        backTile?.setSessionName(newName);
      },

      mount(el, ctx) {
        container = el;
        destroyed = false;
        const entry = terminalPool.getOrCreate(currentSessionName);
        terminalPool.protect(currentSessionName);
        entry.container.style.display = "";
        el.appendChild(entry.container);
        mounted = true;

        // ── Shared status watcher ──────────────────────────────────
        // One poller per session, not one per tile face. Terminal tile
        // owns the watcher; the back tile subscribes instead of running
        // its own interval. See public/lib/session-status-watcher.js.
        watcher = createSessionStatusWatcher({ sessionName: currentSessionName });

        // ── Register dashboard back-face ───────────────────────────
        const carousel = deps.carousel;
        if (carousel) {
          backTile = createDashboardBackTile({ sessionName: currentSessionName, watcher });
          carousel.setBackTile(currentSessionName, backTile);
        }

        // ── Auto-flip on child process exit ────────────────────────
        // When the watcher reports a had-children → no-children
        // transition, schedule a 1.5s debounce then re-poll and flip
        // if still idle. The debounce absorbs brief pauses between
        // commands. The watcher's own destroyed guard covers the fetch
        // side; the `destroyed` flag here covers the setTimeout side.
        watcherUnsubscribe = watcher.subscribe((event) => {
          if (destroyed) return;
          if (!event.transitions?.idle) return;
          if (!carousel || carousel.isFlipped(currentSessionName)) return;
          if (autoFlipTimer) clearTimeout(autoFlipTimer);
          autoFlipTimer = setTimeout(() => {
            if (destroyed) return;
            if (carousel.isFlipped(currentSessionName)) return;
            // Re-check via an immediate poll so we don't flip on a
            // momentary pause between commands. If that poll reports
            // child processes are back, the flip is cancelled.
            watcher.poll().then(() => {
              if (destroyed) return;
              if (carousel.isFlipped(currentSessionName)) return;
              if (backTile?.addEvent) backTile.addEvent("Agent work completed");
              carousel.flipCard(currentSessionName, true);
            }).catch(() => {});
          }, 1500);
        });
      },

      unmount() {
        if (!mounted) return;
        destroyed = true;
        if (autoFlipTimer) { clearTimeout(autoFlipTimer); autoFlipTimer = null; }
        watcherUnsubscribe?.();
        watcherUnsubscribe = null;
        watcher?.destroy();
        watcher = null;
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
        backTile = null;
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
