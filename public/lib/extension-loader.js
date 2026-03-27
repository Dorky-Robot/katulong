/**
 * Extension Loader
 *
 * Fetches the list of installed extensions from /api/extensions and dynamically
 * imports each extension's tile.js module. Each module must export a
 * createTileFactory function that returns a TilePrototype factory.
 *
 * After loading, extensions are registered via registerTileType() and added
 * to the tileTypes menu array.
 *
 * Usage:
 *   const extensionTypes = await loadExtensions();
 *   // extensionTypes is an array of { type, name, icon } for the tile menu
 */

import { registerTileType, hasTileType } from "/lib/tile-registry.js";

/**
 * Load all installed extensions.
 * @returns {Promise<Array<{type: string, name: string, icon: string}>>}
 *   Menu entries for loaded extension tile types.
 */
export async function loadExtensions() {
  const extensionTypes = [];

  let extensions;
  try {
    const resp = await fetch("/api/extensions");
    if (!resp.ok) {
      console.warn("[extensions] Failed to fetch extension list:", resp.status);
      return extensionTypes;
    }
    const data = await resp.json();
    extensions = data.extensions || [];
  } catch (err) {
    console.warn("[extensions] Could not load extension list:", err.message);
    return extensionTypes;
  }

  if (extensions.length === 0) return extensionTypes;

  for (const ext of extensions) {
    try {
      // Skip if this type is already registered (built-in takes precedence)
      if (hasTileType(ext.type)) {
        console.warn(`[extensions] Type "${ext.type}" already registered, skipping ${ext.name}`);
        continue;
      }

      // Dynamically import the extension's tile module.
      // The module URL uses the extension's directory name (_dir is stripped
      // server-side, so we derive it from the type or use the repo basename).
      // Extensions are served at /extensions/<dir-name>/tile.js.
      // We use the type as directory name since that's the convention.
      const dirName = ext.repo
        ? ext.repo.split("/").pop().replace(/^katulong-tile-/, "")
        : ext.type;

      const mod = await import(`/extensions/${dirName}/tile.js`);

      if (typeof mod.createTileFactory !== "function") {
        console.warn(`[extensions] ${ext.name} does not export createTileFactory`);
        continue;
      }

      const factory = mod.createTileFactory();
      registerTileType(ext.type, factory);

      extensionTypes.push({
        type: ext.type,
        name: ext.name,
        icon: ext.icon || "puzzle-piece",
      });

      console.log(`[extensions] Loaded: ${ext.name} (type: ${ext.type})`);
    } catch (err) {
      console.warn(`[extensions] Failed to load ${ext.name}:`, err.message);
    }
  }

  return extensionTypes;
}
