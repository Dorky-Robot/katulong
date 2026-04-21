/**
 * Claude Code hook installer.
 *
 * Wires katulong's `relay-hook` stdin-forwarder into Claude Code by patching
 * `~/.claude/settings.local.json`. Non-destructive: preserves any non-katulong
 * hooks the user has configured. Idempotent: running install twice is a no-op.
 *
 * Two callers:
 *   - `katulong setup claude-hooks` (CLI, lib/cli/commands/setup.js)
 *   - POST /api/claude-hooks/install  (HTTP, lib/routes/app-routes.js)
 *
 * The server route exists so the frontend can auto-install on first click of
 * the Claude icon when we detect a running Claude session in a pane — users
 * should not have to drop to the terminal to enable the feature.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.local.json");
const SETTINGS_TMP_PATH = SETTINGS_PATH + ".tmp";

export const HOOK_EVENTS = [
  "PostToolUse", "Stop", "SubagentStart", "SubagentStop",
  // SessionStart / SessionEnd carry the Claude UUID and let the server
  // populate `session.meta.claude.uuid` so the tile feed button can open
  // the right topic without a lookup. See docs/session-meta.md.
  "SessionStart", "SessionEnd",
  // Notification fires when Claude needs user input (permission prompts,
  // idle nudges). The server turns permission prompts into an interactive
  // menu card on the feed so the reader can answer without dropping to
  // the TTY — see lib/claude-permissions.js.
  "Notification",
];

const RELAY_COMMAND = "katulong relay-hook";
const RELAY_HOOK = { type: "command", command: RELAY_COMMAND };

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Atomic write: two browser tabs both clicking "install" (or the CLI racing
// the HTTP route) could otherwise truncate each other mid-write and leave the
// user with a half-written JSON file that silently drops their other hooks.
function writeSettings(settings) {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS_TMP_PATH, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(SETTINGS_TMP_PATH, SETTINGS_PATH);
}

function eventHasRelay(settings, event) {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => g.hooks?.some((h) => h.command === RELAY_COMMAND));
}

/**
 * Inspect the current install state without mutating anything.
 *
 * @returns {{
 *   installed: boolean,        // true only if every HOOK_EVENT is wired
 *   partiallyInstalled: boolean,
 *   missingEvents: string[],
 *   settingsPath: string,
 * }}
 */
export function getClaudeHooksStatus() {
  const settings = readSettings();
  const missingEvents = HOOK_EVENTS.filter((e) => !eventHasRelay(settings, e));
  return {
    installed: missingEvents.length === 0,
    partiallyInstalled: missingEvents.length > 0 && missingEvents.length < HOOK_EVENTS.length,
    missingEvents,
    settingsPath: SETTINGS_PATH,
  };
}

/**
 * Install the katulong relay hook for any events that don't already have it.
 * Non-destructive: existing non-katulong hooks are preserved. Any stale
 * `http` hooks pointing at the old `/api/claude-events` URL are cleaned up
 * so we don't end up with a double-fire.
 *
 * @returns {{
 *   installed: boolean,       // true after this call (always)
 *   added: string[],          // event names newly wired
 *   alreadyInstalled: string[],
 *   settingsPath: string,
 * }}
 */
export function installClaudeHooks() {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

  const added = [];
  const alreadyInstalled = [];

  for (const event of HOOK_EVENTS) {
    // PostToolUse needs "*" to catch every tool; Notification narrows to
    // permission_prompt so we don't wake the relay for idle nudges the
    // feed can't act on. Others default to empty (all matchers).
    const matcher = event === "PostToolUse" ? "*"
      : event === "Notification" ? "permission_prompt"
      : "";
    if (!settings.hooks[event]) settings.hooks[event] = [];

    if (eventHasRelay(settings, event)) {
      alreadyInstalled.push(event);
      continue;
    }

    // Drop any stale http hooks pointing at the old claude-events URL so a
    // pre-relay-hook install doesn't leave us double-firing.
    settings.hooks[event] = settings.hooks[event].filter(
      (g) => !g.hooks?.some((h) => h.url && h.url.includes("/api/claude-events"))
    );

    settings.hooks[event].push({ matcher, hooks: [RELAY_HOOK] });
    added.push(event);
  }

  if (added.length > 0) {
    writeSettings(settings);
  }

  return {
    installed: true,
    added,
    alreadyInstalled,
    settingsPath: SETTINGS_PATH,
  };
}

/**
 * Remove every katulong relay hook from the settings file. Non-katulong
 * hooks are preserved untouched.
 *
 * @returns {{ removed: string[], settingsPath: string }}
 */
export function removeClaudeHooks() {
  const settings = readSettings();
  if (!settings.hooks) {
    return { removed: [], settingsPath: SETTINGS_PATH };
  }

  const removed = [];
  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) continue;
    const before = settings.hooks[event];
    settings.hooks[event] = before.filter(
      (g) => !g.hooks?.some((h) => h.command === RELAY_COMMAND)
    );
    if (settings.hooks[event].length !== before.length) removed.push(event);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  if (removed.length > 0) {
    writeSettings(settings);
  }

  return { removed, settingsPath: SETTINGS_PATH };
}
