/**
 * Static File Serving
 *
 * Handles serving static files from the public directory with:
 * - Security: Path traversal prevention, directory blocking
 * - Performance: Caching headers, efficient file reads
 * - Correctness: Proper MIME types for all file types
 */

import { resolve, extname, join } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';

// In-memory cache: filePath -> { content, mimeType, mtime }
const fileCache = new Map();

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
  ".wasm": "application/wasm",
};

/**
 * Serve a static file from the public directory.
 *
 * Security checks:
 * - Path must be within publicDir (prevents traversal)
 * - File must exist
 * - File must not be a directory (prevents directory listing)
 *
 * @param {import('http').ServerResponse} res - HTTP response
 * @param {string} publicDir - Public directory path
 * @param {string} pathname - Request pathname (e.g., "/login.js")
 * @param {Object} options - Options
 * @param {boolean} options.cacheControl - Whether to add cache headers (default: true)
 * @param {number} options.maxAge - Cache max-age in seconds (default: 31536000 = 1 year)
 * @returns {boolean} True if file was served, false if not found or error
 */
export function serveStaticFile(res, publicDir, pathname, options = {}) {
  const { cacheControl = true, maxAge = 31536000 } = options;

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
    // File disappeared between existsSync and statSync, or permission error — treat as not found
    return false;
  }

  // Determine MIME type
  const ext = extname(filePath);
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  // Check in-memory cache
  const cached = fileCache.get(filePath);
  const mtime = stats.mtimeMs;
  let content;

  if (cached && cached.mtime === mtime) {
    content = cached.content;
  } else {
    try {
      content = readFileSync(filePath);
    } catch {
      return false;
    }
    fileCache.set(filePath, { content, mimeType, mtime });
  }

  // Set headers
  const headers = {
    "Content-Type": mimeType,
    "Content-Length": content.length,
  };

  if (cacheControl) {
    // Immutable content (vendor files, hashed assets)
    if (pathname.startsWith('/vendor/')) {
      headers["Cache-Control"] = `public, max-age=${maxAge}, immutable`;
    } else {
      // App files (may change between versions)
      headers["Cache-Control"] = `public, max-age=0, must-revalidate`;
    }
  }

  // Send response
  res.writeHead(200, headers);
  res.end(content);
  return true;
}

/**
 * Check if a pathname looks like a static file request.
 * Used to avoid unnecessary checks for non-file requests.
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
  // Reject path traversal attempts
  if (pathname.includes('..')) return false;
  if (pathname.includes('//')) return false;

  // Reject hidden files (starts with .)
  if (pathname.startsWith('/.')) return false;

  // Reject paths with segments starting with . (hidden directories)
  const segments = pathname.split('/');
  for (const segment of segments) {
    if (segment.startsWith('.') && segment !== '') {
      return false;
    }
  }

  return true;
}
