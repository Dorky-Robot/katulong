/**
 * Tile Extension Loader (client-side)
 *
 * Fetches discovered extensions from the server, dynamically imports each
 * extension's tile.js, calls setup(sdk, options), and registers the returned
 * factory with the tile registry.
 *
 * Must run BEFORE carousel restore so that extension tile types are available
 * when restoring saved tiles.
 *
 * Usage:
 *   import { loadTileExtensions } from "/lib/tile-extension-loader.js";
 *   const extensionTypes = await loadTileExtensions({ getWs, api, toast, platform }, registerTileType);
 *   // extensionTypes: [{ type, name, icon, description }]
 */

import { createTileSDK } from "/lib/tile-sdk-impl.js";

/**
 * Load all tile extensions from the server.
 *
 * @param {object} sdkDeps — dependencies passed to createTileSDK (getWs, api, toast, platform)
 * @param {function} registerTileType — from tile-registry.js
 * @returns {Promise<Array<{type, name, icon, description}>>} — loaded extension metadata
 */
export async function loadTileExtensions(sdkDeps, registerTileType) {
  let extensions;
  try {
    console.log("[tile-ext] Fetching extensions...");
    const res = await fetch("/api/tile-extensions");
    if (!res.ok) { console.warn("[tile-ext] fetch failed:", res.status); return []; }
    const data = await res.json();
    extensions = data.extensions || [];
    console.log("[tile-ext] Found extensions:", extensions.map(e => e.name));
  } catch (err) {
    console.error("[tile-ext] Fetch error:", err);
    return [];
  }

  if (extensions.length === 0) return [];

  const loaded = [];

  for (const ext of extensions) {
    const type = ext.type;
    const dir = ext._dir;

    try {
      // Dynamic import of the extension's tile.js
      const mod = await import(`/tiles/${dir}/tile.js`);
      const setup = mod.default || mod.setup;

      if (typeof setup !== "function") {
        console.warn(`[tile-ext] ${dir}/tile.js does not export a setup function`);
        continue;
      }

      // Create a namespaced SDK for this extension
      const sdk = createTileSDK(type, sdkDeps);

      // Call setup to get the tile factory
      const factory = setup(sdk, { config: ext.config || [] });

      if (typeof factory !== "function") {
        console.warn(`[tile-ext] ${dir} setup() did not return a factory function`);
        continue;
      }

      // Register with the tile system
      registerTileType(type, factory);

      loaded.push({
        type,
        name: ext.name,
        icon: ext.icon || "puzzle-piece",
        description: ext.description || "",
      });
    } catch (err) {
      console.error(`[tile-ext] Failed to load extension "${dir}":`, err);
    }
  }

  return loaded;
}
