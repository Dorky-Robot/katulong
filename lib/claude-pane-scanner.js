/**
 * Claude permission-prompt detector via tmux pane scraping.
 *
 * Claude Code's `Notification` hook doesn't fire for in-terminal permission
 * prompts (the "Do you want to proceed? 1/2/3" menu). The only structured
 * signal that a prompt is about to appear is `PreToolUse`, which fires
 * *before* Claude even renders the menu. So after a PreToolUse we poll
 * the session's tmux pane and look for the prompt text — if it appears
 * within a short window we publish a permission-request card; if the
 * tool auto-approves (no prompt), the pane never matches and the poll
 * finishes empty.
 *
 * See the /api/claude-events handler in app-routes.js for wiring.
 */

import { tmuxExec } from "./tmux.js";

const PANE_RE = /^%\d+$/;

/**
 * Claude's permission question always takes the shape "Do you want to
 * <verb> <thing>?". Seen in the wild for Bash (proceed), Edit (make this
 * edit), Write (create this file), WebFetch (fetch this URL), and MCP.
 * A loose wording match catches all of them without us needing to
 * enumerate tools.
 */
const PROMPT_RE = /Do you want to[^?\n]{0,80}\?/i;

/**
 * The numbered option list after the question. Claude prefixes the
 * currently-highlighted option with `❯` (or `>` / `›` in some terminals).
 * Match "1." as a line-start token so we don't false-positive on body
 * text that happens to contain "1." mid-sentence.
 */
const OPTION_RE = /^\s*[›>❯▶]?\s*1\.\s+\S/m;

/**
 * Shell out to `tmux capture-pane -p -t <pane>` and return the visible
 * viewport as plain text. Returns null on any failure (bad pane id,
 * tmux unreachable, non-zero exit, empty capture).
 *
 * We deliberately don't pass `-S <neg>` to pull in scrollback. The
 * question is always "is the prompt currently on screen?", and scrollback
 * would let an already-answered prompt match long after it's gone.
 *
 * @param {string} pane - tmux pane id like "%9"
 * @param {{ exec?: typeof tmuxExec }} [opts]
 */
export async function capturePane(pane, { exec = tmuxExec } = {}) {
  if (typeof pane !== "string" || !PANE_RE.test(pane)) return null;
  const { code, stdout } = await exec(["capture-pane", "-p", "-t", pane]);
  if (code !== 0) return null;
  return stdout || null;
}

/**
 * Run the prompt/option regex pair against captured pane text.
 * Pure — exported separately so tests can drive it without shelling out.
 *
 * @returns {{ question: string } | null}
 */
export function detectPermissionPrompt(paneText) {
  if (typeof paneText !== "string") return null;
  const qMatch = paneText.match(PROMPT_RE);
  if (!qMatch) return null;
  if (!OPTION_RE.test(paneText)) return null;
  return { question: qMatch[0] };
}

/**
 * Poll the pane for a permission prompt across a small set of delays.
 * PreToolUse fires *before* Claude renders the menu, so the first
 * capture is almost always empty — we need to wait a beat.
 *
 * Stops early if `shouldStop()` returns true. The app wires this to
 * "PostToolUse arrived for the same session" — once the tool has run,
 * no prompt will appear and further polling is wasted work.
 *
 * @param {string} pane
 * @param {object} [opts]
 * @param {number[]} [opts.delaysMs] - wait before each capture attempt.
 *   The total window (~5s default) matches how long a user can
 *   realistically ignore a prompt before we stop caring.
 * @param {() => boolean} [opts.shouldStop]
 * @param {(pane: string) => Promise<string|null>} [opts.capture]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ question: string } | null>}
 */
export async function pollForPermissionPrompt(pane, {
  delaysMs = [150, 300, 500, 800, 1200, 2000],
  shouldStop = () => false,
  capture = capturePane,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (const delay of delaysMs) {
    await sleep(delay);
    if (shouldStop()) return null;
    const text = await capture(pane);
    const hit = detectPermissionPrompt(text);
    if (hit) return hit;
  }
  return null;
}
