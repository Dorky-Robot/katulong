/**
 * Extension Loader
 *
 * Discovers installed extensions, loads their modules, and registers them
 * in the tile registry. Each extension's setup() receives a real SDK object
 * with storage, sessions, terminal, pubsub, etc.
 *
 * Usage:
 *   const extensionTypes = await loadExtensions({ sendWs, onWsMessage });
 *   // extensionTypes = [{ type, name, icon }] for the tile menu
 */

import { registerTileType, hasTileType } from "/lib/tile-registry.js";
import { createTileSDK } from "/lib/tile-sdk-impl.js";

/**
 * Load all installed extensions.
 * @param {object} deps — platform dependencies for SDK creation
 * @param {function} deps.sendWs — send WebSocket message
 * @param {function} deps.onWsMessage — subscribe to WS messages
 * @param {object} deps.platform — platform info
 * @returns {Promise<Array<{type: string, name: string, icon: string}>>}
 */
export async function loadExtensions(deps = {}) {
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
      if (hasTileType(ext.type)) {
        console.warn(`[extensions] Type "${ext.type}" already registered, skipping ${ext.name}`);
        continue;
      }

      // Derive the directory name from the repo or type
      const dirName = ext.repo
        ? ext.repo.split("/").pop().replace(/^katulong-tile-/, "")
        : ext.type;

      const mod = await import(`/extensions/${dirName}/tile.js`);

      if (typeof mod.default !== "function") {
        console.warn(`[extensions] ${ext.name}: no default export function`);
        continue;
      }

      // Per the Tile SDK: export default function setup(sdk, options) → TilePrototype
      // Build a real SDK for this tile type and call setup() fresh each time.
      const setupFn = mod.default;
      const factory = (options = {}) => {
        const sdk = createTileSDK({ tileType: ext.type, ...deps });
        return setupFn(sdk, { ...options, ...(ext.config || []).reduce((acc, c) => { if (c.default !== undefined) acc[c.key] = c.default; return acc; }, {}) });
      };

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
