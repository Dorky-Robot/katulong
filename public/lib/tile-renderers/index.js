/**
 * Tile Renderer Registry
 *
 * Central registry mapping tile type strings to renderer objects.
 * Each renderer exposes:
 *   - describe(props) → { title, icon, persistable }   (pure)
 *   - mount(el, api)  → { unmount, focus, blur, resize, tile }
 *   - init(deps)      — one-time dep injection at startup
 *
 * The registry itself is a plain Map. Renderers self-register at import
 * time via registerRenderer(), or can be bulk-registered at boot.
 */

import { terminalRenderer } from "./terminal.js";
import { fileBrowserRenderer } from "./file-browser.js";
import { clusterRenderer } from "./cluster.js";

const renderers = new Map();

export function registerRenderer(renderer) {
  if (!renderer?.type) throw new Error("renderer must have a .type");
  renderers.set(renderer.type, renderer);
}

export function getRenderer(type) {
  return renderers.get(type) || null;
}

/** Does this tile type persist across reloads? */
export function isPersistable(type) {
  const r = renderers.get(type);
  if (!r) return false;
  // Ask the renderer with empty props — persistable is type-level, not
  // instance-level (a terminal is always persistable regardless of which
  // session it wraps).
  return r.describe({}).persistable === true;
}

/** Initialize all built-in renderers with their deps. */
export function initRenderers({ terminalPool, createTerminalTile }) {
  terminalRenderer.init({ terminalPool });
  fileBrowserRenderer.init({});
  clusterRenderer.init({ createTerminalTile });
}

// Register built-in renderers
registerRenderer(terminalRenderer);
registerRenderer(fileBrowserRenderer);
registerRenderer(clusterRenderer);
