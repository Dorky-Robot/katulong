/**
 * Terminal Tile
 *
 * Adapts the existing terminalPool as a TilePrototype. Each instance wraps
 * a single terminal session. The pool continues to own xterm.js lifecycle,
 * LRU eviction, WebGL rendering, and pull-based output — this tile is a
 * thin adapter that speaks the tile interface.
 */

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
    let mounted = false;
    let container = null;

    return {
      type: "terminal",

      /** The session name this tile wraps. */
      sessionName,

      mount(el, ctx) {
        container = el;
        const entry = terminalPool.getOrCreate(sessionName);
        terminalPool.protect(sessionName);
        entry.container.style.display = "";
        el.appendChild(entry.container);
        mounted = true;

        // No toolbar for plain terminals — session name is shown in the tab bar.
      },

      unmount() {
        if (!mounted) return;
        terminalPool.unprotect(sessionName);
        const entry = terminalPool.get(sessionName);
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
        const entry = terminalPool.get(sessionName);
        if (!entry) return;
        terminalPool.setActive(sessionName);
        terminalPool.attachControls(sessionName);
        entry.term.focus();
        this.resize();
      },

      blur() {
        // Terminal keeps running in the background — nothing to do.
      },

      resize() {
        terminalPool.scale(sessionName);
      },

      getTitle() {
        return sessionName;
      },

      getIcon() {
        return "terminal-window";
      },

      serialize() {
        return { type: "terminal", sessionName };
      },
    };
  };
}
