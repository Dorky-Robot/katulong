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

import { createFileBrowserStore, loadRoot } from "../file-browser/file-browser-store.js";
import { createFileBrowserComponent } from "../file-browser/file-browser-component.js";

/**
 * Create the file-browser tile factory. Call once at startup with shared
 * deps (currently none — the tile owns its own store per instance).
 *
 * @returns {(options: { cwd?: string, sessionName?: string }) => TilePrototype}
 */
export function createFileBrowserTileFactory(_deps = {}) {
  return function createFileBrowserTile({ cwd = "", sessionName = null } = {}) {
    let currentCwd = cwd;
    let container = null;
    let mounted = false;
    let component = null;
    // Each tile has its own store — mirroring per-tile independence of
    // terminal tiles. Sharing one global store across multiple browser
    // tiles would couple their navigation state and break serialize().
    const store = createFileBrowserStore();

    const tile = {
      type: "file-browser",

      get sessionName() { return sessionName; },
      get cwd() { return currentCwd; },

      mount(el, ctx) {
        container = el;
        // Mount the component directly onto the tile-chrome content
        // element. Previously a wrapper <div> existed to protect
        // tile-chrome's `.tile-content` flex rules from
        // createFileBrowserComponent clobbering `container.className =
        // "file-browser"`. Tier 1 T1b fixed the component to own a
        // `.fb-root` child, so the wrapper is no longer needed.
        component = createFileBrowserComponent(store, {
          // The file-browser component draws its own X button in its
          // header. When hosted as a tile, that X must remove this
          // tile from its container. Route through ctx.requestClose
          // (carousel-provided) so onCardDismissed fires and the
          // tab set / subscriptions stay consistent. Falls back to a
          // no-op if the container does not supply requestClose (e.g.
          // a future non-carousel host) so the tile never throws.
          onClose: () => { ctx?.requestClose?.(); },
        });
        component.mount(el);
        loadRoot(store, currentCwd);
        mounted = true;
      },

      unmount() {
        if (!mounted) return;
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
        if (!currentCwd || currentCwd === "/") return "Files";
        const segments = currentCwd.split("/").filter(Boolean);
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
