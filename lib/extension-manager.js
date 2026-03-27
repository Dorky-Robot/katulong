/**
 * Extension Manager
 *
 * Discovers and serves tile extensions from ~/.katulong/extensions/.
 * Extensions are directories containing a manifest.json and tile.js file.
 *
 * Extension directory structure:
 *   ~/.katulong/extensions/<name>/
 *     manifest.json   — metadata (name, type, description, icon, version, author, repo)
 *     tile.js         — ES module exporting a tile factory
 *
 * Server routes:
 *   GET /api/extensions              — list installed extensions
 *   GET /extensions/:name/tile.js    — serve the extension's tile module
 *   GET /extensions/:name/manifest.json — serve the manifest
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

/**
 * Get the extensions directory path.
 * @param {string} dataDir — ~/.katulong or equivalent
 * @returns {string}
 */
export function extensionsDir(dataDir) {
  return join(dataDir, "extensions");
}

/**
 * List installed extensions by reading manifest.json from each subdirectory.
 * @param {string} dataDir
 * @returns {object[]} Array of manifest objects with added `dir` field
 */
export function listExtensions(dataDir) {
  const dir = extensionsDir(dataDir);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const extensions = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip hidden directories
    if (entry.name.startsWith(".")) continue;

    const extDir = join(dir, entry.name);
    const manifestPath = join(extDir, "manifest.json");

    if (!existsSync(manifestPath)) {
      log.warn("Extension missing manifest.json", { name: entry.name });
      continue;
    }

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      // Validate required fields
      if (!manifest.name || !manifest.type) {
        log.warn("Extension manifest missing required fields (name, type)", { dir: entry.name });
        continue;
      }

      // Check tile.js exists
      const tilePath = join(extDir, "tile.js");
      if (!existsSync(tilePath)) {
        log.warn("Extension missing tile.js", { name: manifest.name });
        continue;
      }

      extensions.push({ ...manifest, _dir: entry.name });
    } catch (err) {
      log.warn("Failed to read extension manifest", { dir: entry.name, error: err.message });
    }
  }

  return extensions;
}

/**
 * Create routes for extension management.
 * @param {object} ctx — { json, auth, DATA_DIR }
 * @returns {object[]} Route definitions
 */
export function createExtensionRoutes(ctx) {
  const { json, auth, DATA_DIR } = ctx;

  return [
    // List installed extensions
    {
      method: "GET",
      path: "/api/extensions",
      handler: auth((_req, res) => {
        const extensions = listExtensions(DATA_DIR);
        // Strip internal _dir field from response
        const cleaned = extensions.map(({ _dir, ...rest }) => rest);
        json(res, 200, { extensions: cleaned });
      }),
    },

    // Serve extension files (tile.js and manifest.json)
    {
      method: "GET",
      prefix: "/extensions/",
      handler: auth((req, res, param) => {
        // param is e.g. "my-extension/tile.js" or "my-extension/manifest.json"
        const match = param.match(/^([a-zA-Z0-9_-]+)\/(tile\.js|manifest\.json)$/);
        if (!match) {
          json(res, 404, { error: "Not found" });
          return;
        }

        const [, name, file] = match;
        const dir = extensionsDir(DATA_DIR);
        const filePath = join(dir, name, file);

        // Verify the resolved path is within the extensions directory (prevent traversal)
        const resolvedPath = join(dir, name, file);
        if (!resolvedPath.startsWith(dir)) {
          json(res, 403, { error: "Forbidden" });
          return;
        }

        if (!existsSync(filePath)) {
          json(res, 404, { error: "Not found" });
          return;
        }

        try {
          const content = readFileSync(filePath, "utf-8");
          const contentType = file === "tile.js" ? "application/javascript" : "application/json";
          res.writeHead(200, {
            "Content-Type": `${contentType}; charset=utf-8`,
            "Cache-Control": "no-cache",
          });
          res.end(content);
        } catch (err) {
          log.error("Failed to serve extension file", { name, file, error: err.message });
          json(res, 500, { error: "Internal server error" });
        }
      }),
    },
  ];
}
