/**
 * Tile Extension Scanner & Server
 *
 * Discovers tile extensions from ~/.katulong/tiles/ and serves their files.
 * Mirrors the plugin-loader.js pattern for server-side discovery.
 *
 * Extension directory structure:
 *   ~/.katulong/tiles/<name>/
 *     manifest.json   — metadata (name, type, icon, description, config)
 *     tile.js         — ES module: export default function setup(sdk, options)
 *     ...             — additional files (elements/, styles, etc.)
 *
 * Routes:
 *   GET /api/tile-extensions — list discovered extensions
 *   GET /tiles/:name/:path  — serve extension files (JS, JSON, CSS)
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { log } from "./log.js";

const MIME_TYPES = {
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
};

/**
 * Scan the tiles directory and return discovered extensions.
 * @param {string} dataDir — ~/.katulong or equivalent
 * @returns {Array<{name, manifest, dir}>}
 */
export function discoverTileExtensions(dataDir) {
  const tilesDir = join(dataDir, "tiles");
  if (!existsSync(tilesDir)) return [];

  const results = [];
  let entries;
  try {
    entries = readdirSync(tilesDir, { withFileTypes: true });
  } catch (err) {
    log.warn("Failed to read tiles directory", { error: err.message });
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const dir = join(tilesDir, entry.name);
    const manifestPath = join(dir, "manifest.json");
    const tilePath = join(dir, "tile.js");

    if (!existsSync(manifestPath)) continue;
    if (!existsSync(tilePath)) {
      log.warn("Tile extension missing tile.js", { name: entry.name });
      continue;
    }

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (!manifest.name) {
        log.warn("Tile manifest missing 'name'", { dir: entry.name });
        continue;
      }
      results.push({
        name: entry.name,
        manifest,
        dir,
      });
    } catch (err) {
      log.warn("Failed to parse tile manifest", { name: entry.name, error: err.message });
    }
  }

  return results;
}

/**
 * Create HTTP routes for tile extension discovery and file serving.
 * @param {object} ctx
 * @param {function} ctx.json — json(res, status, body)
 * @param {function} ctx.auth — auth middleware wrapper
 * @param {string} ctx.DATA_DIR — ~/.katulong
 * @returns {Array<{method, path?, prefix?, handler}>}
 */
export function createTileExtensionRoutes(ctx) {
  const { json, auth, DATA_DIR } = ctx;

  // Cache discovered extensions at startup
  let extensions = discoverTileExtensions(DATA_DIR);
  log.info("Tile extensions discovered", { count: extensions.length, names: extensions.map(e => e.name) });

  return [
    // List discovered extensions
    {
      method: "GET",
      path: "/api/tile-extensions",
      handler: auth((_req, res) => {
        // Re-scan on each request (extensions might be installed at runtime)
        extensions = discoverTileExtensions(DATA_DIR);
        const list = extensions.map(({ name, manifest }) => ({
          name: manifest.name || name,
          type: manifest.type || name,
          description: manifest.description || "",
          icon: manifest.icon || "puzzle-piece",
          version: manifest.version || "0.0.0",
          author: manifest.author || "",
          config: manifest.config || [],
          _dir: name,
        }));
        json(res, 200, { extensions: list });
      }),
    },

    // Serve extension files
    {
      method: "GET",
      prefix: "/tiles/",
      handler: auth((req, res, param) => {
        // param is e.g., "plano/tile.js" or "plano/elements/tala-md.js"
        const slashIdx = param.indexOf("/");
        if (slashIdx === -1) return json(res, 404, { error: "Not found" });

        const extName = param.slice(0, slashIdx);
        const filePath = param.slice(slashIdx + 1);

        // Validate extension name (alphanumeric, hyphens, underscores)
        if (!/^[a-zA-Z0-9_-]+$/.test(extName)) return json(res, 400, { error: "Invalid extension name" });

        // Find the extension
        const ext = extensions.find(e => e.name === extName);
        if (!ext) return json(res, 404, { error: "Extension not found" });

        // Resolve file path safely (prevent path traversal)
        const resolved = resolve(ext.dir, filePath);
        if (!resolved.startsWith(ext.dir)) return json(res, 403, { error: "Forbidden" });

        // Check file exists
        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
          return json(res, 404, { error: "File not found" });
        }

        // Serve with correct MIME type
        const mimeType = MIME_TYPES[extname(resolved)] || "application/octet-stream";
        try {
          const content = readFileSync(resolved);
          res.writeHead(200, {
            "Content-Type": mimeType,
            "Cache-Control": "no-store, no-cache, must-revalidate",
          });
          res.end(content);
        } catch (err) {
          log.error("Failed to serve tile file", { ext: extName, file: filePath, error: err.message });
          json(res, 500, { error: "Internal error" });
        }
      }),
    },
  ];
}
