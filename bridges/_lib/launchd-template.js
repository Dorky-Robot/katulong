/**
 * Generates a per-bridge LaunchAgent plist. Mirrors the deterministic-PATH
 * lesson from lib/cli/commands/service.js — never inherit the calling
 * shell's PATH (a non-interactive ssh would otherwise bake a stripped
 * PATH into the plist and break tmux/node lookup on respawn).
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";

const STANDARD_PLIST_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function buildPlistPath(bin) {
  const binDir = bin ? dirname(bin) : null;
  return [...new Set([binDir, ...STANDARD_PLIST_PATH_DIRS].filter(Boolean))].join(":");
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function bridgeLabel(bridgeName) {
  // Period-separated, mirrors com.dorkyrobot.katulong's label scheme.
  return `com.dorkyrobot.katulong-bridge.${bridgeName}`;
}

export function bridgePlistPath(bridgeName) {
  return join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${bridgeLabel(bridgeName)}.plist`,
  );
}

/**
 * Build the plist XML for a bridge. `bin` is the absolute path to the
 * katulong binary that will be invoked with `bridge <name> start`.
 * `dataDir` is katulong's data directory (e.g. ~/.katulong).
 */
export function buildBridgePlist({ bridgeName, bin, dataDir }) {
  const label = bridgeLabel(bridgeName);
  const path = buildPlistPath(bin);
  const stdoutLog = `${dataDir}/bridges/${bridgeName}/stdout.log`;
  const stderrLog = `${dataDir}/bridges/${bridgeName}/stderr.log`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bin)}</string>
    <string>bridge</string>
    <string>${xmlEscape(bridgeName)}</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>KATULONG_DATA_DIR</key>
    <string>${xmlEscape(dataDir)}</string>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrLog)}</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>`;
}
