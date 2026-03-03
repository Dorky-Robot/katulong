/**
 * File Browser API
 *
 * REST endpoints for browsing, downloading, uploading, and managing files
 * on the host machine. All routes require authentication. Mutation routes
 * also require CSRF validation.
 */

import { stat, readdir, mkdir, rename, cp, rm, writeFile } from "node:fs/promises";
import { resolve, basename, dirname, extname, join } from "node:path";
import { realpathSync, createReadStream } from "node:fs";
import { log } from "./log.js";
import { readRawBody } from "./request-util.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB per file

/**
 * Validate and normalize a user-supplied path.
 * Returns the resolved absolute path, or throws on anything suspicious.
 */
function safePath(userPath) {
  if (typeof userPath !== "string" || !userPath) {
    throw new Error("Path is required");
  }
  if (userPath.includes("..") || userPath.includes("//")) {
    throw new Error("Invalid path");
  }
  const resolved = resolve("/", userPath);
  try {
    return realpathSync(resolved);
  } catch {
    // For new paths (rename/mkdir targets), fall back to resolve only
    return resolved;
  }
}

/**
 * Map file extension to human-readable kind string.
 */
function fileKind(name, isDir) {
  if (isDir) return "Folder";
  const ext = extname(name).toLowerCase();
  const kinds = {
    ".txt": "Plain Text", ".md": "Markdown", ".json": "JSON",
    ".js": "JavaScript", ".ts": "TypeScript", ".jsx": "JSX", ".tsx": "TSX",
    ".py": "Python Script", ".rb": "Ruby Script", ".go": "Go Source",
    ".rs": "Rust Source", ".sh": "Shell Script", ".zsh": "Zsh Script",
    ".bash": "Bash Script",
    ".html": "HTML", ".css": "CSS", ".xml": "XML", ".yaml": "YAML", ".yml": "YAML",
    ".png": "PNG Image", ".jpg": "JPEG Image", ".jpeg": "JPEG Image",
    ".gif": "GIF Image", ".svg": "SVG Image", ".webp": "WebP Image",
    ".pdf": "PDF Document", ".doc": "Word Document", ".docx": "Word Document",
    ".xls": "Excel Spreadsheet", ".xlsx": "Excel Spreadsheet",
    ".zip": "ZIP Archive", ".tar": "TAR Archive", ".gz": "GZ Archive",
    ".mp3": "MP3 Audio", ".mp4": "MP4 Video", ".mov": "MOV Video",
    ".dmg": "Disk Image", ".pkg": "Installer Package",
    ".env": "Environment", ".log": "Log File",
    ".toml": "TOML", ".ini": "INI Config", ".cfg": "Config",
  };
  return kinds[ext] || (ext ? `${ext.slice(1).toUpperCase()} File` : "Document");
}

/**
 * Create file browser route definitions.
 * @param {object} ctx - Route context (json, parseJSON, auth, csrf, etc.)
 * @returns {Array} Route definition objects
 */
export function createFileBrowserRoutes(ctx) {
  const { json, parseJSON, auth, csrf } = ctx;

  return [
    // --- List directory ---
    {
      method: "GET", path: "/api/files", handler: auth(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const dirPath = url.searchParams.get("path") || process.env.HOME || "/";

        let resolved;
        try {
          resolved = safePath(dirPath);
        } catch {
          return json(res, 400, { error: "Invalid path" });
        }

        let stats;
        try {
          stats = await stat(resolved);
        } catch {
          return json(res, 404, { error: "Path not found" });
        }

        if (!stats.isDirectory()) {
          return json(res, 400, { error: "Not a directory" });
        }

        let dirEntries;
        try {
          dirEntries = await readdir(resolved, { withFileTypes: true });
        } catch (err) {
          if (err.code === "EACCES") {
            return json(res, 403, { error: "Permission denied" });
          }
          return json(res, 500, { error: "Failed to read directory" });
        }

        const entries = [];
        for (const entry of dirEntries) {
          const entryPath = join(resolved, entry.name);
          const isDir = entry.isDirectory();
          let size = 0;
          let modified = null;
          try {
            const s = await stat(entryPath);
            size = isDir ? 0 : s.size;
            modified = s.mtime.toISOString();
          } catch {
            // Permission denied or broken symlink — include with defaults
            modified = new Date(0).toISOString();
          }
          entries.push({
            name: entry.name,
            type: isDir ? "directory" : "file",
            size,
            modified,
            kind: fileKind(entry.name, isDir),
          });
        }

        json(res, 200, { path: resolved, entries });
      }),
    },

    // --- Download file ---
    {
      method: "GET", path: "/api/files/download", handler: auth(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          return json(res, 400, { error: "Path is required" });
        }

        let resolved;
        try {
          resolved = safePath(filePath);
        } catch {
          return json(res, 400, { error: "Invalid path" });
        }

        let stats;
        try {
          stats = await stat(resolved);
        } catch {
          return json(res, 404, { error: "File not found" });
        }

        if (stats.isDirectory()) {
          return json(res, 400, { error: "Cannot download a directory" });
        }

        const filename = basename(resolved).replace(/[\x00-\x1f\x7f]/g, "_");
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename.replace(/"/g, '\\"')}"`,
          "Content-Length": stats.size,
        });

        const stream = createReadStream(resolved);
        stream.pipe(res);
        stream.on("error", (err) => {
          log.error("File download stream error", { path: resolved, error: err.message });
          if (!res.headersSent) {
            json(res, 500, { error: "Failed to read file" });
          } else {
            res.end();
          }
        });
      }),
    },

    // --- Upload file ---
    {
      method: "POST", path: "/api/files/upload", handler: auth(csrf(async (req, res) => {
        const targetDir = req.headers["x-target-dir"];
        const filename = req.headers["x-filename"];

        if (!targetDir || !filename) {
          return json(res, 400, { error: "X-Target-Dir and X-Filename headers are required" });
        }

        if (filename.includes("/") || filename.includes("\\") || filename === ".." || filename === "." || /[\x00-\x1f\x7f]/.test(filename)) {
          return json(res, 400, { error: "Invalid filename" });
        }

        let resolvedDir;
        try {
          resolvedDir = safePath(targetDir);
        } catch {
          return json(res, 400, { error: "Invalid target directory" });
        }

        let buf;
        try {
          buf = await readRawBody(req, MAX_UPLOAD_BYTES);
        } catch {
          return json(res, 413, { error: "File too large (max 100 MB)" });
        }

        const destPath = join(resolvedDir, filename);
        try {
          await writeFile(destPath, buf);
        } catch (err) {
          if (err.code === "EACCES") {
            return json(res, 403, { error: "Permission denied" });
          }
          return json(res, 500, { error: "Failed to write file" });
        }

        json(res, 200, { ok: true, path: destPath });
      })),
    },

    // --- Create directory ---
    {
      method: "POST", path: "/api/files/mkdir", handler: auth(csrf(async (req, res) => {
        const { path: dirPath } = await parseJSON(req);
        if (!dirPath) {
          return json(res, 400, { error: "Path is required" });
        }

        let resolved;
        try {
          resolved = safePath(dirPath);
        } catch {
          return json(res, 400, { error: "Invalid path" });
        }

        try {
          await mkdir(resolved, { recursive: false });
        } catch (err) {
          if (err.code === "EEXIST") {
            return json(res, 409, { error: "Directory already exists" });
          }
          if (err.code === "EACCES") {
            return json(res, 403, { error: "Permission denied" });
          }
          return json(res, 500, { error: "Failed to create directory" });
        }

        json(res, 201, { ok: true, path: resolved });
      })),
    },

    // --- Rename ---
    {
      method: "POST", path: "/api/files/rename", handler: auth(csrf(async (req, res) => {
        const { path: itemPath, name } = await parseJSON(req);
        if (!itemPath || !name) {
          return json(res, 400, { error: "Path and name are required" });
        }

        if (name.includes("/") || name.includes("\\") || name === ".." || name === "." || /[\x00-\x1f\x7f]/.test(name)) {
          return json(res, 400, { error: "Invalid name" });
        }

        let resolved;
        try {
          resolved = safePath(itemPath);
        } catch {
          return json(res, 400, { error: "Invalid path" });
        }

        const newPath = join(dirname(resolved), name);
        try {
          await rename(resolved, newPath);
        } catch (err) {
          if (err.code === "ENOENT") {
            return json(res, 404, { error: "File not found" });
          }
          if (err.code === "EACCES") {
            return json(res, 403, { error: "Permission denied" });
          }
          return json(res, 500, { error: "Failed to rename" });
        }

        json(res, 200, { ok: true, path: newPath });
      })),
    },

    // --- Move items ---
    {
      method: "POST", path: "/api/files/move", handler: auth(csrf(async (req, res) => {
        const { items, destination } = await parseJSON(req);
        if (!Array.isArray(items) || items.length === 0 || items.length > 1000 || !destination) {
          return json(res, 400, { error: "Items array (1-1000) and destination are required" });
        }

        let destResolved;
        try {
          destResolved = safePath(destination);
        } catch {
          return json(res, 400, { error: "Invalid destination" });
        }

        const results = [];
        for (const item of items) {
          let srcResolved;
          try {
            srcResolved = safePath(item);
          } catch {
            results.push({ item, error: "Invalid path" });
            continue;
          }
          const newPath = join(destResolved, basename(srcResolved));
          try {
            await rename(srcResolved, newPath);
            results.push({ item, ok: true });
          } catch (err) {
            results.push({ item, error: err.message });
          }
        }

        json(res, 200, { ok: true, results });
      })),
    },

    // --- Copy items ---
    {
      method: "POST", path: "/api/files/copy", handler: auth(csrf(async (req, res) => {
        const { items, destination } = await parseJSON(req);
        if (!Array.isArray(items) || items.length === 0 || items.length > 1000 || !destination) {
          return json(res, 400, { error: "Items array (1-1000) and destination are required" });
        }

        let destResolved;
        try {
          destResolved = safePath(destination);
        } catch {
          return json(res, 400, { error: "Invalid destination" });
        }

        const results = [];
        for (const item of items) {
          let srcResolved;
          try {
            srcResolved = safePath(item);
          } catch {
            results.push({ item, error: "Invalid path" });
            continue;
          }
          const newPath = join(destResolved, basename(srcResolved));
          try {
            await cp(srcResolved, newPath, { recursive: true });
            results.push({ item, ok: true });
          } catch (err) {
            results.push({ item, error: err.message });
          }
        }

        json(res, 200, { ok: true, results });
      })),
    },

    // --- Delete items ---
    {
      method: "POST", path: "/api/files/delete", handler: auth(csrf(async (req, res) => {
        const { items } = await parseJSON(req);
        if (!Array.isArray(items) || items.length === 0 || items.length > 1000) {
          return json(res, 400, { error: "Items array (1-1000) is required" });
        }

        const results = [];
        for (const item of items) {
          let resolved;
          try {
            resolved = safePath(item);
          } catch {
            results.push({ item, error: "Invalid path" });
            continue;
          }

          // Prevent deleting root
          if (resolved === "/") {
            results.push({ item, error: "Cannot delete root" });
            continue;
          }

          try {
            await rm(resolved, { recursive: true });
            results.push({ item, ok: true });
          } catch (err) {
            results.push({ item, error: err.message });
          }
        }

        json(res, 200, { ok: true, results });
      })),
    },
  ];
}
