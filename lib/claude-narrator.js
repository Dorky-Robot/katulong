/**
 * Claude narrator — pure helpers that walk a normalized Claude transcript
 * entry and pull out the bits the feed tile cares about.
 *
 * Right now that's just the files Claude touched — used by the feed
 * renderer to show clickable chips next to each reply. Earlier versions
 * of this module also asked Ollama for a one-line title per reply and
 * maintained a rolling narrative summary; both were removed once the
 * feed's "one flat reply per turn, no collapsing" UX made them
 * redundant.
 *
 * No I/O, no state, no broker coupling. The processor imports these and
 * decides what to do with the results.
 */

import { basename } from "node:path";

/**
 * Extract unique file paths touched by an assistant entry's tool_use
 * blocks. Read, Write, Edit, Grep, Glob, and plain `cd <path>` Bash
 * commands all count. Globs (paths containing `*`) are skipped because
 * they don't point at a single file the user can open.
 *
 * Returns an array of `{ path, line? }`, deduped by *basename* (first
 * occurrence wins, with line promotion — see below).
 *
 * Why basename and not full path? The chip the user sees shows the
 * basename, so two different paths that share a basename (e.g. eight
 * `SKILL.md` files across directories) previously rendered as eight
 * identical-looking chips. That's noise, not information. Collapsing
 * to one chip per basename makes the footer scannable; the user can
 * still click through to open the first occurrence. Line promotion
 * is intentionally gated on *same path*: an Edit-then-Read-with-offset
 * sequence on the same file promotes the offset onto the retained
 * entry, but a line number from a different file that merely shares
 * a basename does NOT bleed across — it would navigate the user to a
 * line that was never associated with the retained path.
 *
 * Line is only set for Read at an offset — the only tool whose
 * arguments carry one we can show.
 *
 * @param {{ tools?: Array<{name: string, input: object}> }} entry
 * @returns {Array<{ path: string, line?: number }>}
 */
export function extractFilesFromEntry(entry) {
  if (!entry || !Array.isArray(entry.tools) || entry.tools.length === 0) return [];
  const seen = new Map();

  function add(path, line) {
    if (typeof path !== "string" || !path) return;
    if (path.includes("*")) return;
    const key = basename(path);
    if (!key) return;
    const nextLine = typeof line === "number" && line > 0 ? line : undefined;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { path, line: nextLine });
      return;
    }
    // Edit-then-Read-with-offset on the *same* path: promote the line so
    // the chip links to the edited offset. Gated on same path because
    // line numbers from a different file would mislead the user.
    if (existing.line === undefined && nextLine !== undefined && existing.path === path) {
      existing.line = nextLine;
    }
  }

  for (const t of entry.tools) {
    const input = t.input || {};
    switch (t.name) {
      case "Read":
        add(input.file_path, input.offset);
        break;
      case "Write":
      case "Edit":
        add(input.file_path);
        break;
      case "Grep":
      case "Glob":
        if (typeof input.path === "string") add(input.path);
        break;
      case "Bash": {
        const cmd = typeof input.command === "string" ? input.command : "";
        const m = cmd.match(/^\s*cd\s+["']?([^"';&|]+)/);
        if (m) add(m[1].trim());
        break;
      }
      default:
        break;
    }
  }
  return [...seen.values()].map(({ path, line }) =>
    line !== undefined ? { path, line } : { path }
  );
}

/** System prompt for the rolling session summary. Two parts — a
 *  tight short form pinned at the top of the feed, and a longer form
 *  used for the terminal-tab tooltip. Output format is constrained so
 *  the caller can parse it without an LLM-grade JSON library. */
export const SUMMARY_SYSTEM_PROMPT = `You summarize a live Claude Code coding session for a developer skimming a feed. Output EXACTLY in this format, with no preamble, no code fences, and no trailing notes:

SHORT:
<two to three sentences describing what this session is about — what we're building, fixing, or exploring. Present tense. Concrete enough to jog memory six hours later, compressive enough to read in a breath. No filler like "the user is asking" or "the assistant is helping".>

LONG:
<four to eight sentences expanding on the short form: the through-line of the session, decisions made, open threads. Still in present tense, still concrete. Don't narrate every tool call; name the arc.>

Update the summary to reflect the latest state. If the session focus has pivoted, rewrite — do not append. Never mention "this summary" or "in this update"; speak about the work, not the meta.`;

/**
 * Generate a short+long running summary of the Claude session so far.
 *
 * Caller passes a compact excerpt of recent transcript (the processor
 * hands in the last N user/assistant turns) and the previous summary
 * for continuity. The model is expected to produce both a two-to-three
 * sentence SHORT form and a four-to-eight sentence LONG form; if
 * parsing fails both sides fall back to the raw response so callers
 * can still show *something* and surface the parse failure in logs.
 *
 * @param {object} opts
 * @param {string}   opts.transcript    Formatted excerpt (see processor).
 * @param {object}   [opts.previous]    Previous { short, long } or null.
 * @param {function} opts.callOllama    async (userPrompt, { systemPrompt }) => string
 * @returns {Promise<{short: string, long: string} | null>}
 */
export async function summarizeSession({ transcript, previous, callOllama }) {
  if (typeof callOllama !== "function") {
    throw new Error("summarizeSession: callOllama is required");
  }
  if (typeof transcript !== "string" || !transcript.trim()) return null;

  const prevBlock = previous?.short || previous?.long
    ? `PREVIOUS SUMMARY:\nSHORT: ${previous.short || ""}\nLONG: ${previous.long || ""}\n\n`
    : "";
  const userPrompt = `${prevBlock}RECENT TRANSCRIPT:\n${transcript}\n\nWrite the updated SHORT and LONG summaries.`;

  const raw = await callOllama(userPrompt, { systemPrompt: SUMMARY_SYSTEM_PROMPT });
  if (typeof raw !== "string" || !raw.trim()) return null;

  return parseShortLongResponse(raw);
}

/**
 * Parse the "SHORT: ... LONG: ..." format emitted by
 * SUMMARY_SYSTEM_PROMPT into an object. Tolerates surrounding
 * whitespace, optional blank lines, and mismatched case in the
 * labels. Exported for unit tests. (Name-disambiguated from
 * `session-summarizer.js`'s JSON-shaped `parseSummaryResponse` so
 * a future caller that imports from the wrong module fails loudly
 * instead of silently returning null against a mismatched shape.)
 */
export function parseShortLongResponse(raw) {
  const text = String(raw).trim();
  if (!text) return null;

  // Locate the LONG section header; everything before it (after the
  // SHORT header if present) is the short form.
  const longIdx = text.search(/^\s*LONG\s*:/mi);
  if (longIdx < 0) {
    // No divider — treat the whole thing as the short form and
    // synthesize a long form that mirrors it. Better than dropping the
    // response entirely on a minor format break.
    const short = stripLeadingLabel(text, "SHORT");
    return { short, long: short };
  }
  const shortBlock = stripLeadingLabel(text.slice(0, longIdx).trim(), "SHORT");
  const longBlock = stripLeadingLabel(text.slice(longIdx).trim(), "LONG");
  return {
    short: shortBlock.trim(),
    long: longBlock.trim(),
  };
}

function stripLeadingLabel(block, label) {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*`, "i");
  return block.replace(re, "");
}

// Re-export readTranscriptEntries so callers that used to reach for the
// narrator-plus-reader combo still have a single "read a slice" door.
export { readTranscriptEntries } from "./claude-event-transform.js";
