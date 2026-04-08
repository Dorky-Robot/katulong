/**
 * Image upload helpers
 *
 * Detects image MIME from magic bytes, writes uploaded images to disk,
 * and bridges them into the host clipboard (macOS via osascript, Linux
 * via xclip). Shared between the /upload route (initial drop) and the
 * /paste route (replay onto a new session).
 *
 * Extracted from lib/routes.js (Tier 3.4) so the helpers can be tested
 * directly and the routes module shrinks to just routing logic.
 */

import { execFile } from "node:child_process";
import { log } from "../log.js";
import { tmuxSocketArgs } from "../tmux.js";

const IMAGE_SIGNATURES = [
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), ext: "png" },
  { magic: Buffer.from([0xff, 0xd8, 0xff]),        ext: "jpg" },
  { magic: Buffer.from("GIF8"),                     ext: "gif" },
];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Detect image format from magic bytes.
 * @param {Buffer} buf
 * @returns {string|null} extension ("png", "jpg", "gif", "webp") or null
 */
export function detectImage(buf) {
  for (const sig of IMAGE_SIGNATURES) {
    if (buf.length >= sig.magic.length && buf.subarray(0, sig.magic.length).equals(sig.magic)) {
      return sig.ext;
    }
  }
  if (buf.length >= 12 && buf.subarray(0, 4).equals(Buffer.from("RIFF")) && buf.subarray(8, 12).equals(Buffer.from("WEBP"))) {
    return "webp";
  }
  return null;
}

/**
 * Map an extension to its HTTP MIME type.
 */
export function imageMimeType(ext) {
  return ext === "png" ? "image/png" : ext === "gif" ? "image/gif"
    : ext === "webp" ? "image/webp" : "image/jpeg";
}

/**
 * Set the host clipboard to an image file.
 * Returns true if clipboard was set successfully.
 *
 * The `logger` parameter is injected so the route can pass its scoped
 * logger; defaults to the shared `log` for direct callers and tests.
 */
export async function setClipboard(filePath, ext, logger = log) {
  if (process.platform === "darwin") {
    const applescriptType = ext === "png" ? "«class PNGf»" : ext === "gif" ? "«class GIFf»" : "«class JPEG»";
    try {
      await new Promise((resolve, reject) => {
        execFile("osascript", ["-e", `set the clipboard to (read (POSIX file "${filePath}") as ${applescriptType})`],
          { timeout: 5000 }, (err) => err ? reject(err) : resolve());
      });
      return true;
    } catch (err) {
      logger.warn("Failed to copy image to clipboard", { error: err.message });
    }
  } else if (process.platform === "linux") {
    if (!process.env.DISPLAY) {
      try {
        const xvfbDisplay = await new Promise((resolve, reject) => {
          execFile("pgrep", ["-a", "Xvfb"], { timeout: 2000 }, (err, stdout) => {
            if (err) return reject(err);
            const match = stdout.match(/:(\d+)/);
            resolve(match ? `:${match[1]}` : null);
          });
        });
        if (xvfbDisplay) {
          process.env.DISPLAY = xvfbDisplay;
          logger.info("Auto-detected Xvfb display", { display: xvfbDisplay });
          execFile("tmux", [...tmuxSocketArgs(), "setenv", "-g", "DISPLAY", xvfbDisplay], { timeout: 2000 }, () => {});
        }
      } catch { /* Xvfb not running */ }
    }
    const mimeType = imageMimeType(ext);
    try {
      await new Promise((resolve, reject) => {
        execFile("xclip", ["-selection", "clipboard", "-t", mimeType, "-i", filePath],
          { timeout: 5000 }, (err) => err ? reject(err) : resolve());
      });
      return true;
    } catch (err) {
      const msg = err.code === "ENOENT"
        ? "xclip not installed — image clipboard paste disabled (apt-get install xclip)"
        : `xclip failed — image clipboard paste disabled (is DISPLAY set?)`;
      logger.warn(msg, { error: err.message });
    }
  }
  return false;
}
