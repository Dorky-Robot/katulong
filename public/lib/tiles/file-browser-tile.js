/**
 * File Browser Tile
 *
 * Hosts the Miller-columns file browser component as a first-class
 * katulong tile. Same seam as terminal-tile.js: card-carousel builds
 * tile-chrome on a card face and calls `mount(contentEl)`; this tile
 * mounts the file-browser component into that plain DOM node.
 *
 * This is NOT a generic HTML-tile revival. PR #533 removed the plugin
 * SDK (tile-registry, html-tile, manifest discovery, canClose hooks).
 * This tile is one more hard-coded in-tree tile kind, constructed by
 * app.js the same way terminal and cluster tiles are. No registry,
 * no loader, no community tiles — just another concrete use of the
 * existing tile-chrome primitive.
 */

import { createFileBrowserStore, createNavController, getDeepestPath } from "../file-browser/file-browser-store.js";
import { createFileBrowserComponent } from "../file-browser/file-browser-component.js";

/**
 * Create the file-browser tile factory. Call once at startup with shared
 * deps (currently none — the tile owns its own store per instance).
 *
 * @returns {(options: { cwd?: string, sessionName?: string }) => TilePrototype}
 */
export function createFileBrowserTileFactory(_deps = {}) {
  return function createFileBrowserTile({ cwd = "", sessionName = null, onFileOpen = null, onFileDownload = null } = {}) {
    let currentCwd = cwd;
    let container = null;
    let mounted = false;
    let component = null;
    let unsubscribeStore = null;
    // Each tile has its own store and nav controller — mirroring per-tile
    // independence of terminal tiles. Sharing one global store across
    // multiple browser tiles would couple their navigation state and
    // break serialize(). The nav controller scopes request cancellation
    // per instance so rapid clicks in one tile don't cancel fetches in another.
    const store = createFileBrowserStore();
    const nav = createNavController(store);

    const tile = {
      type: "file-browser",

      // File-browser tiles persist across reload. Earlier (commit b86275c)
      // they were marked non-persistable out of a concern that resurrecting
      // them would produce "empty phantom" tiles — but that was only true
      // before serialize() captured `cwd`. With cwd in the snapshot and
      // restoreTile() in app.js rebuilding the factory at that cwd, the
      // restored tile lands in the same directory the user left it.
      persistable: true,

      get sessionName() { return sessionName; },
      get cwd() { return currentCwd; },

      mount(el, ctx) {
        container = el;
        component = createFileBrowserComponent(store, nav, {
          // The file-browser component draws its own X button in its
          // header. When hosted as a tile, that X must remove this
          // tile from its container. Route through ctx.requestClose
          // (carousel-provided) so onCardDismissed fires and the
          // tab set / subscriptions stay consistent. Falls back to a
          // no-op if the container does not supply requestClose (e.g.
          // a future non-carousel host) so the tile never throws.
          onClose: () => { ctx?.requestClose?.(); },
          onFileOpen,
          onFileDownload,
        });
        component.mount(el);
        nav.loadRoot(currentCwd);
        // Track the deepest navigated path as the tile's "current" path
        // so the tab label follows the user's folder navigation. Notify
        // the host (carousel/tab bar) via ctx.setTitle whenever it moves.
        unsubscribeStore = store.subscribe(() => {
          const deepest = getDeepestPath(store.getState());
          if (deepest && deepest !== currentCwd) {
            currentCwd = deepest;
            ctx?.setTitle?.(tile.getTitle());
          }
        });
        mounted = true;
      },

      unmount() {
        if (!mounted) return;
        if (unsubscribeStore) { unsubscribeStore(); unsubscribeStore = null; }
        component?.unmount?.();
        component = null;
        if (container) container.innerHTML = "";
        container = null;
        mounted = false;
      },

      focus() {
        component?.focus?.();
      },

      blur() {
        // File browser has no background work to pause.
      },

      resize() {
        // Miller columns use flexbox — they reflow automatically.
      },

      getTitle() {
        const cwd = typeof currentCwd === "string" ? currentCwd : "";
        if (!cwd || cwd === "/") return "Files";
        const segments = cwd.split("/").filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] : "Files";
      },

      getIcon() {
        return "folder";
      },

      serialize() {
        return { type: "file-browser", cwd: currentCwd, sessionName };
      },
    };

    return tile;
  };
}
