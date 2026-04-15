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
import { resolveSessionId } from "../api-client.js";

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
       *  serialize, etc.) see the new name instead of the original.
       *  The watcher polls by id and needs no update; the back tile
       *  still tracks the friendly name for display. */
      setSessionName(newName) {
        currentSessionName = newName;
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
        // Status polling is keyed on the immutable session id, not the
        // friendly name — the id is resolved asynchronously at mount
        // and doesn't change on rename. Back tile + auto-flip wiring
        // wait until the id is known; if resolution fails (session was
        // killed externally between persist and mount) the tile stays
        // in its "no status" baseline state, which is harmless — the
        // terminal pool still shows the last known screen.
        const faceStack = ctx?.faceStack;
        resolveSessionId(currentSessionName).then((sessionId) => {
          if (destroyed) return;
          watcher = createSessionStatusWatcher({ sessionId });

          if (faceStack) {
            backTile = createDashboardBackTile({
              sessionName: currentSessionName,
              sessionId,
              watcher,
            });
            faceStack.setSecondary(backTile);
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
            if (!faceStack || faceStack.isShowingSecondary()) return;
            if (autoFlipTimer) clearTimeout(autoFlipTimer);
            autoFlipTimer = setTimeout(() => {
              if (destroyed) return;
              if (faceStack.isShowingSecondary()) return;
              // Re-check via an immediate poll so we don't flip on a
              // momentary pause between commands. If that poll reports
              // child processes are back, the flip is cancelled.
              watcher.poll().then(() => {
                if (destroyed) return;
                if (faceStack.isShowingSecondary()) return;
                if (backTile?.addEvent) backTile.addEvent("Agent work completed");
                faceStack.showSecondary(true);
              }).catch(() => {});
            }, 1500);
          });
        }).catch(() => { /* session missing — baseline state is fine */ });
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
