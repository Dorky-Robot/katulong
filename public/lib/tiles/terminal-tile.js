/**
 * Terminal Tile
 *
 * Adapts the existing terminalPool as a TilePrototype. Each instance wraps
 * a single terminal session. The pool continues to own xterm.js lifecycle,
 * LRU eviction, WebGL rendering, and pull-based output — this tile is a
 * thin adapter that speaks the tile interface.
 */

import { createDashboardBackTile } from "./dashboard-back-tile.js";

/**
 * Create the terminal tile factory. Call once at startup with shared deps,
 * then register the returned factory with the tile registry.
 *
 * @param {object} deps
 * @param {object} deps.terminalPool — the terminal pool instance
 * @param {object} [deps.carousel] — carousel instance (for setBackTile)
 * @param {function} [deps.createTileFn] — createTile from registry
 * @returns {(options: { sessionName: string }) => TilePrototype}
 */
export function createTerminalTileFactory(deps) {
  const { terminalPool, createTileFn } = deps;
  return function createTerminalTile({ sessionName }) {
    // Mutable: rename updates this via setSessionName(). Every method below
    // reads `currentSessionName` (not the destructured parameter) so that
    // rename, lookup, persistence, and pool calls all stay in sync.
    let currentSessionName = sessionName;
    let mounted = false;
    let container = null;
    let backTile = null;
    let statusPollTimer = null;
    let prevHasChildProcesses = false;
    let autoFlipTimer = null;

    // ── Status polling for auto-flip ──────────────────────────────
    // Declared above the tile object so the textual order matches the
    // execution order — function declarations would hoist either way,
    // but placing them after `return tile` reads as dead code.

    function startStatusPoll(ctx, carousel) {
      if (statusPollTimer) return;
      statusPollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/sessions/${encodeURIComponent(currentSessionName)}/status`);
          if (!res.ok) return;
          const status = await res.json();
          const hasChild = status.hasChildProcesses || false;

          // Detect transition: had child processes -> no child processes
          if (prevHasChildProcesses && !hasChild && carousel && !carousel.isFlipped(currentSessionName)) {
            // Small delay (1.5s) to avoid flipping during brief pauses
            if (autoFlipTimer) clearTimeout(autoFlipTimer);
            autoFlipTimer = setTimeout(() => {
              // Re-check: still no child processes?
              fetch(`/sessions/${encodeURIComponent(currentSessionName)}/status`)
                .then(r => r.ok ? r.json() : null)
                .then(s => {
                  if (s && !s.hasChildProcesses && !carousel.isFlipped(currentSessionName)) {
                    if (backTile?.addEvent) backTile.addEvent("Agent work completed");
                    carousel.flipCard(currentSessionName, true);
                  }
                })
                .catch(() => {});
            }, 1500);
          }

          prevHasChildProcesses = hasChild;
        } catch {
          // Network error or session doesn't exist — ignore
        }
      }, 5000);
    }

    function stopStatusPoll() {
      if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
      if (autoFlipTimer) { clearTimeout(autoFlipTimer); autoFlipTimer = null; }
    }

    const tile = {
      type: "terminal",

      /** The session name this tile wraps (current — kept in sync on rename). */
      get sessionName() { return currentSessionName; },

      /** Update the session name after a tab rename. The carousel calls
       *  this from renameCard() so that subsequent lookups (findCard,
       *  serialize, etc.) see the new name instead of the original. */
      setSessionName(newName) {
        currentSessionName = newName;
      },

      mount(el, ctx) {
        container = el;
        const entry = terminalPool.getOrCreate(currentSessionName);
        terminalPool.protect(currentSessionName);
        entry.container.style.display = "";
        el.appendChild(entry.container);
        mounted = true;

        // ── Register dashboard back-face ───────────────────────────
        const carousel = deps.carousel;
        if (carousel) {
          backTile = createDashboardBackTile({ sessionName: currentSessionName });
          carousel.setBackTile(currentSessionName, backTile);
        }

        // ── Auto-flip on child process exit ────────────────────────
        // Poll session status; when child processes transition from
        // true -> false, auto-flip to the dashboard after a short delay.
        startStatusPoll(ctx, carousel);
      },

      unmount() {
        if (!mounted) return;
        stopStatusPoll();
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
