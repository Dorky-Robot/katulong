/**
 * Shared utilities for LaunchAgent plist generation. Used by `service.js`
 * (the main katulong LaunchAgent install path).
 *
 * The path list and XML escaper stay here because anything else under
 * `lib/cli/` that grows into a launchd-aware subcommand should reuse
 * the same well-tested primitives. Both are load-bearing for plist
 * correctness — the path list survives a non-interactive ssh's stripped
 * environment, and the escaper prevents value-borne XML injection.
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
