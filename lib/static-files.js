/**
 * Static File Serving
 *
 * Handles serving static files from the public directory with:
 * - Security: Path traversal prevention, directory blocking
 * - Performance: Caching headers, efficient file reads
 * - Correctness: Proper MIME types for all file types
 * - Cache busting: Vendor files get content-hash query params injected
 *   into JS/HTML references so CDN and browser caches are invalidated
 *   automatically when vendor files change between versions.
 */

import { resolve, extname, join } from 'node:path';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// In-memory cache: filePath -> { content, mimeType, mtime, hash }
const fileCache = new Map();

// Vendor content hash registry: "/vendor/xterm/addon-fit.esm.js" -> "a1b2c3d4"
const vendorHashes = new Map();

/**
 * MIME type mapping for static files.
 * Using application/javascript for ES modules (not text/javascript).
 */
export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/**
 * Compute a short content hash for a file.
 * @param {Buffer|string} content
 * @returns {string} 8-char hex hash
 */
function contentHash(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Build the vendor hash registry by scanning all files under publicDir/vendor/.
 * Called once at startup and after clearFileCache().
 *
 * @param {string} publicDir - Path to the public directory
 */
export function buildVendorHashes(publicDir) {
  vendorHashes.clear();
  const vendorDir = join(publicDir, "vendor");
  if (!existsSync(vendorDir)) return;

  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else {
        const ext = extname(entry.name);
        if (ext === ".js" || ext === ".css") {
          const filePath = join(dir, entry.name);
          const content = readFileSync(filePath);
          const hash = contentHash(content);
          const urlPath = `/vendor/${prefix}${entry.name}`;
          vendorHashes.set(urlPath, hash);
        }
      }
    }
  }

  walk(vendorDir, "");
}

/**
 * Rewrite vendor URLs in HTML or JS content, appending content-hash
 * query parameters for cache busting.
 *
 * Matches patterns like:
 *   "/vendor/xterm/addon-fit.esm.js"
 *   "/vendor/xterm/addon-fit.esm.js?v=2"
 * And replaces with:
 *   "/vendor/xterm/addon-fit.esm.js?h=a1b2c3d4"
 *
 * @param {string} text - HTML or JS content
 * @returns {string} Content with vendor URLs rewritten
 */
export function rewriteVendorUrls(text) {
  // Match /vendor/....(js|css) optionally followed by ?anything, inside quotes
  return text.replace(
    /(["'])(\/vendor\/[^"']+?\.(js|css))(?:\?[^"']*)?(\1)/g,
    (match, q1, path, _ext, q2) => {
      const hash = vendorHashes.get(path);
      if (hash) {
        return `${q1}${path}?h=${hash}${q2}`;
      }
      return match;
    }
  );
}

/**
 * Serve a static file from the public directory.
 *
 * Security checks:
 * - Path must be within publicDir (prevents traversal)
 * - File must exist
 * - File must not be a directory (prevents directory listing)
 *
 * JS files that import vendor modules are automatically rewritten
 * with content-hash cache busters so CDN caches are invalidated
 * when vendor files change.
 *
 * @param {import('http').ServerResponse} res - HTTP response
 * @param {string} publicDir - Public directory path
 * @param {string} pathname - Request pathname (e.g., "/login.js")
 * @param {Object} options - Options
 * @param {boolean} options.cacheControl - Whether to add cache headers (default: true)
 * @returns {boolean} True if file was served, false if not found or error
 */
export function serveStaticFile(res, publicDir, pathname, options = {}) {
  const { cacheControl = true } = options;

  // Security: Validate pathname (reject path traversal, hidden files)
  if (!isSafePathname(pathname)) {
    return false;
  }

  // Normalize pathname (remove leading slash)
  const relativePath = pathname.startsWith('/') ? pathname.slice(1) : pathname;

  // Resolve file path (prevents path traversal)
  const filePath = resolve(publicDir, relativePath);

  // Security: Ensure file is within publicDir
  if (!filePath.startsWith(publicDir)) {
    return false;
  }

  // Check if file exists
  if (!existsSync(filePath)) {
    return false;
  }

  // Security: Ensure it's a file, not a directory
  let stats;
  try {
    stats = statSync(filePath);
    if (stats.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  // Determine MIME type
  const ext = extname(filePath);
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  // Check in-memory cache
  const cached = fileCache.get(filePath);
  const mtime = stats.mtimeMs;
  let content;
  let hash;

  if (cached && cached.mtime === mtime) {
    content = cached.content;
    hash = cached.hash;
  } else {
    try {
      content = readFileSync(filePath);
    } catch {
      return false;
    }

    // Rewrite vendor import URLs in JS files so they include content hashes.
    // Only apply to JS files outside /vendor/ that reference vendor paths.
    if (ext === ".js" && !pathname.startsWith("/vendor/") && vendorHashes.size > 0) {
      const text = content.toString();
      if (text.includes("/vendor/")) {
        content = Buffer.from(rewriteVendorUrls(text));
      }
    }

    hash = contentHash(content);
    fileCache.set(filePath, { content, mimeType, mtime, hash });
  }

  // Set headers
  const headers = {
    "Content-Type": mimeType,
    "Content-Length": content.length,
  };

  if (cacheControl) {
    headers["Cache-Control"] = "public, max-age=0, must-revalidate";
    headers["ETag"] = `"${hash}"`;
  }

  // Send response
  res.writeHead(200, headers);
  res.end(content);
  return true;
}

/**
 * Check if a pathname looks like a static file request.
 *
 * @param {string} pathname - Request pathname
 * @returns {boolean} True if pathname has a file extension
 */
export function isStaticFileRequest(pathname) {
  const ext = extname(pathname);
  return ext !== '' && ext !== '/';
}

/**
 * Get MIME type for a file extension.
 *
 * @param {string} ext - File extension (with or without leading dot)
 * @returns {string} MIME type
 */
export function getMimeType(ext) {
  const normalized = ext.startsWith('.') ? ext : `.${ext}`;
  return MIME_TYPES[normalized] || "application/octet-stream";
}

/**
 * Clear the in-memory file cache.
 * Call this when files change (e.g., dev-mode file watcher).
 * Vendor hashes are preserved since they only change when vendor files
 * themselves are updated (requires a buildVendorHashes call or server restart).
 */
export function clearFileCache() {
  fileCache.clear();
}

/**
 * Validate that a pathname is safe for static file serving.
 * Rejects path traversal attempts and hidden files.
 *
 * @param {string} pathname - Request pathname
 * @returns {boolean} True if pathname is safe
 */
export function isSafePathname(pathname) {
  if (pathname.includes('..')) return false;
  if (pathname.includes('//')) return false;
  if (pathname.startsWith('/.')) return false;

  const segments = pathname.split('/');
  for (const segment of segments) {
    if (segment.startsWith('.') && segment !== '') {
      return false;
    }
  }

  return true;
}
