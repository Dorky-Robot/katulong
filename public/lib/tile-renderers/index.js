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
import { documentRenderer } from "./document.js";
import { clusterRenderer } from "./cluster.js";
import { feedRenderer } from "./feed.js";
import { localhostBrowserRenderer } from "./localhost-browser.js";
import { progressRenderer } from "./progress.js";
import { imageRenderer } from "./image.js";

const renderers = new Map();

export function registerRenderer(renderer) {
  if (!renderer?.type) throw new Error("renderer must have a .type");
  renderers.set(renderer.type, renderer);
}

export function getRenderer(type) {
  return renderers.get(type) || null;
}

/**
 * Does this tile instance persist across reloads?
 *
 * Accepts optional props for instance-level decisions — the document
 * tile is persistable when file-backed but not when content-backed.
 * Renderers that don't vary by instance ignore the props argument.
 */
export function isPersistable(type, props = {}) {
  const r = renderers.get(type);
  if (!r) return false;
  return r.describe(props).persistable === true;
}

/** Initialize all built-in renderers with their deps. */
export function initRenderers({ terminalPool, createTerminalTile, uiStore, getSessionStore }) {
  terminalRenderer.init({ terminalPool });
  fileBrowserRenderer.init({ uiStore });
  documentRenderer.init({});
  clusterRenderer.init({ createTerminalTile });
  feedRenderer.init({ getSessionStore });
  localhostBrowserRenderer.init({});
  progressRenderer.init({});
  imageRenderer.init({});
}

// Register built-in renderers
registerRenderer(terminalRenderer);
registerRenderer(fileBrowserRenderer);
registerRenderer(documentRenderer);
registerRenderer(clusterRenderer);
registerRenderer(feedRenderer);
registerRenderer(localhostBrowserRenderer);
registerRenderer(progressRenderer);
registerRenderer(imageRenderer);
