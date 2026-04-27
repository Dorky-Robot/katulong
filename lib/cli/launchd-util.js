/**
 * Shared utilities for LaunchAgent plist generation. Used by both
 * `service.js` (the main katulong service) and `bridges/_lib/launchd-template.js`
 * (any bridge installed via `katulong bridge <name> install`).
 *
 * Keeping these here prevents drift: the path-list and the XML escaper are
 * both load-bearing for plist correctness, and divergence between two copies
 * silently breaks bridges or the main service depending on which copy
 * received the fix.
 */

import { dirname } from "node:path";

/**
 * The PATH a LaunchAgent should run with. Listed deterministically rather
 * than inherited from the calling shell — a non-interactive ssh's stripped
 * PATH would otherwise bake into the plist and break tmux/node lookup on
 * next respawn (lesson from PR #662). Apple Silicon paths come first; Intel
 * Homebrew and standard system paths follow as a complete fallback set.
 */
export const STANDARD_PLIST_PATH_DIRS = Object.freeze([
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]);

/**
 * Escape a value for safe interpolation inside a plist `<string>` element.
 * Defense-in-depth: any value flowing in from outside (`bin` from `which`,
 * env vars, manifest fields) could contain XML metacharacters that would
 * otherwise produce malformed XML — or, worse, inject extra `<key>`/`<string>`
 * elements that launchd would happily honor.
 */
export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the PATH string a LaunchAgent should use. Prepends the directory
 * holding the resolved binary (so npm-global / nvm / manual installs still
 * work) ahead of the deterministic standard set; deduplicates if the bin
 * is already in the standard set.
 *
 * A binDir containing `:` or whitespace is dropped: `:` would silently
 * split into spurious PATH entries and whitespace usually indicates a
 * pathological install location not worth honoring.
 */
export function buildLaunchAgentPath(bin) {
  const rawBinDir = bin ? dirname(bin) : null;
  const binDir = rawBinDir && !/[:\s]/.test(rawBinDir) ? rawBinDir : null;
  return [...new Set([binDir, ...STANDARD_PLIST_PATH_DIRS].filter(Boolean))].join(":");
}
