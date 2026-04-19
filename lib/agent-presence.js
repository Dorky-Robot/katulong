/**
 * Coding-agent presence registry.
 *
 * Answers "is a coding agent running in this pane?" from tmux's
 * `pane_current_command` value alone — no hooks, no installer, no
 * per-harness integration required for the baseline signal. This is
 * what the sparkle indicator gates on.
 *
 * Multi-harness design intent:
 *   The registry is the extension point. Today only Claude Code is
 *   wired up because that's the only harness in active use here, but
 *   opencode / codex / aider / future agents each plug in by adding
 *   one entry. Each entry declares:
 *     - `kind`       — stable identifier surfaced to the frontend
 *     - `test(cmd)`  — returns true when pane_current_command matches
 *   First-match-wins; order matters only when patterns could overlap
 *   (SemVer is Claude's runtime title-rename quirk, not a generic
 *   pattern, so keeping claude first is fine).
 *
 *   Per-harness ENRICHMENT (Claude's transcript uuid, for example) is
 *   intentionally NOT in this file. Presence is universal; enrichment
 *   is harness-specific and lives under its own `meta.<kind>` key
 *   (e.g. `meta.claude.uuid` populated from /api/claude-events). The
 *   core UI gates on `meta.agent.kind`; harness-specific tiles read
 *   their own namespace for extra detail. Adding a second harness
 *   means: (1) one entry here, (2) optionally a sibling
 *   `meta.<kind>.*` writer if that harness has a richer signal worth
 *   surfacing, (3) one more branch in the frontend feed opener.
 */

// Claude Code sets `process.title` to its running version at startup,
// and on macOS/BSD tmux reads that title via `kinfo_proc.p_comm` — so
// a live Claude pane shows `2.1.109` (or similar), not `claude`. The
// SemVer matcher is narrow enough that no other well-known CLI sets
// its process title to a dotted three-component numeric string.
const CLAUDE_COMMAND_NAMES = new Set(["claude", "claude-code"]);
const SEMVER_TITLE_RE = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;

function claudeMatches(cmd) {
  if (CLAUDE_COMMAND_NAMES.has(cmd)) return true;
  return SEMVER_TITLE_RE.test(cmd);
}

/**
 * Registry of agent matchers. Add a new harness by appending an entry.
 * Keep patterns strict — false positives turn unrelated shell sessions
 * into apparent agent sessions, which is confusing UX.
 *
 * @type {ReadonlyArray<{ kind: string, test: (cmd: string) => boolean }>}
 */
export const AGENT_MATCHERS = Object.freeze([
  { kind: "claude", test: claudeMatches },
  // Future:
  //   { kind: "opencode", test: (cmd) => cmd === "opencode" },
  //   { kind: "codex",    test: (cmd) => cmd === "codex" },
  //   { kind: "aider",    test: (cmd) => cmd === "aider" },
]);

/**
 * Classify a tmux `pane_current_command` string. Returns the matching
 * agent `kind` (e.g. `"claude"`) or `null` if no matcher hits.
 *
 * @param {string | null | undefined} cmd
 * @returns {string | null}
 */
export function detectAgent(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return null;
  for (const m of AGENT_MATCHERS) {
    if (m.test(cmd)) return m.kind;
  }
  return null;
}

/**
 * Back-compat helper: true iff the command classifies as Claude Code.
 * Preserved for callers that only care about the Claude case. Prefer
 * `detectAgent(cmd) === "claude"` in new code.
 *
 * @param {string | null | undefined} cmd
 * @returns {boolean}
 */
export function isClaudeCommand(cmd) {
  return detectAgent(cmd) === "claude";
}
