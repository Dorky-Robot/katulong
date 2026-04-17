/**
 * Claude narrator — pure transform from a Claude-transcript slice to feed
 * events, plus synchronous helpers for the fast-path cards (Stop, PreToolUse)
 * that don't need an Ollama round-trip.
 *
 * This module owns the shape of every message published to `claude/<uuid>`
 * topics. It does NOT own: debouncing, cursor advancement, topic-broker
 * publish, concurrency caps, or in-memory per-topic state. Those belong to
 * the processor; this narrator is just the "translate Claude-output → events"
 * step.
 *
 * The rolling summary and objective are passed in and returned. The caller
 * persists them (for us: on the watchlist entry, alongside the cursor). A
 * narrator call with empty inputs returns empty outputs — no side effects.
 */
import { readTranscriptEntries } from "./claude-event-transform.js";

const MAX_SUMMARY_LENGTH = 2000;
const STOP_TEXT_MAX_CHARS = 500;

export const SYSTEM_PROMPT = `You are a narrator for a live coding session. You receive slices of a Claude Code session transcript — user prompts, assistant reasoning and tool calls, and tool results — and transform them into a running narrative, like a developer's blog post being written in real time.

Respond in EXACTLY this format — two sections separated by a "---" line:

OBJECTIVE: <one sentence describing the overall goal of this session — what are we trying to accomplish?>
---
<narrative chunk: 2-4 sentences continuing the story>

Guidelines for the narrative chunk:
- Focus on the WHY, not just the WHAT — "Reading the auth module to understand the session flow" not "Read auth.js"
- When code is being edited, mention what changed and why (infer from context)
- Group related tool calls into a single narrative beat — don't enumerate every file read
- Use inline \`code\` for file names, function names, variables
- Skip routine operations (cd, ls) unless they reveal something interesting
- If the session is exploring/searching, say what it's looking for
- If there's a bug being fixed, track the investigation arc
- Keep each chunk short — this is a stream, not an essay
- Never start with "The session" or "Claude" — vary your openings
- Write in present tense
- Use markdown formatting

Guidelines for the OBJECTIVE line:
- One sentence, plain text (no markdown)
- Capture the high-level goal, not the current step
- Update it as the session's focus evolves
- Example: "Building a narrative feed that summarizes Claude Code sessions into blog-like updates"

You'll also receive a SUMMARY of the narrative so far for continuity. Continue naturally from where it left off.`;

/**
 * Narrate a transcript slice.
 *
 * @param {object} opts
 * @param {object[]} opts.entries     - normalized transcript entries (from readTranscriptEntries)
 * @param {string}   [opts.summary]   - rolling narrative-so-far (passed in by caller)
 * @param {string}   [opts.objective] - last-known session objective (so we can detect change)
 * @param {function} opts.callOllama  - async (userPrompt, { systemPrompt }) => markdownString
 * @returns {Promise<{events: object[], summary: string, objective: string}>}
 *          events: ordered list of feed messages to publish (may be empty).
 *                  Each event has shape { step, status, detail, event, tool, files? }.
 *          summary: updated rolling summary (same string if no narrative was produced).
 *          objective: updated objective (same string if unchanged).
 */
export async function narrateSlice({ entries, summary = "", objective = "", callOllama }) {
  if (typeof callOllama !== "function") throw new Error("narrateSlice: callOllama is required");

  const empty = { events: [], summary, objective };

  if (!Array.isArray(entries) || entries.length === 0) return empty;
  if (!hasRealWork(entries)) return empty;

  const userPrompt = buildPrompt(entries, summary);
  const raw = await callOllama(userPrompt, { systemPrompt: SYSTEM_PROMPT });
  if (!raw || !raw.trim()) return empty;

  const { objective: newObjective, narrative } = parseResponse(raw.trim());
  const events = [];
  let nextSummary = summary;
  let nextObjective = objective;

  if (narrative) {
    const files = extractFiles(entries);
    events.push({
      step: narrative,
      status: "narrative",
      detail: "",
      event: "Narrative",
      tool: null,
      files,
    });
    nextSummary = updateSummary(summary, narrative);
  }

  if (newObjective && newObjective !== objective) {
    nextObjective = newObjective;
    events.push({
      step: newObjective,
      status: "summary",
      detail: "",
      event: "Summary",
      tool: null,
    });
  }

  return { events, summary: nextSummary, objective: nextObjective };
}

/**
 * Build a completion-or-attention card from a Stop event's last assistant
 * message. Returns null when there's no text (e.g., /clear, cancelled turn)
 * so the caller can skip publishing — nothing written, no topic created.
 */
export function buildStopCard(text) {
  if (!text || typeof text !== "string") return null;
  if (detectAttention(text)) {
    return {
      step: text,
      status: "attention",
      detail: "",
      event: "Attention",
      tool: null,
    };
  }
  const trimmed = text.length > STOP_TEXT_MAX_CHARS
    ? text.slice(0, STOP_TEXT_MAX_CHARS - 3) + "…"
    : text;
  return {
    step: trimmed,
    status: "completion",
    detail: "",
    event: "Completion",
    tool: null,
  };
}

/**
 * Build an attention card for a PreToolUse event — Claude is waiting on
 * permission to run a tool.
 */
export function buildPreToolUseCard({ toolName, target }) {
  if (!toolName) return null;
  const display = target || toolName;
  return {
    step: `Approve **${toolName}**: \`${display}\`?\n\n1. Yes\n2. No`,
    status: "attention",
    detail: "",
    event: "Attention",
    tool: toolName,
  };
}

// ── pure helpers (exported for unit tests) ─────────────────────────

/**
 * Does this slice contain anything worth narrating? Sessions that only
 * emit session metadata (e.g., /clear, /resume, cancelled turns before
 * any work) produce no user prompt and no assistant activity.
 */
export function hasRealWork(entries) {
  for (const e of entries) {
    if (e.role === "user" && e.text) return true;
    if (e.role === "assistant" && (e.text || (e.tools && e.tools.length > 0))) return true;
  }
  return false;
}

/**
 * Extract unique file paths (with optional line numbers) from tool_use
 * blocks in a transcript slice. We walk assistant entries' `tools` arrays;
 * line numbers come from Read.offset where available.
 */
export function extractFiles(entries) {
  const seen = new Map();

  function add(path, line) {
    if (!path || typeof path !== "string") return;
    if (!seen.has(path)) {
      seen.set(path, typeof line === "number" && line > 0 ? line : undefined);
    }
  }

  for (const entry of entries) {
    if (entry.role !== "assistant" || !Array.isArray(entry.tools)) continue;
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
          if (typeof input.path === "string" && !input.path.includes("*")) {
            add(input.path);
          }
          break;
        case "Bash": {
          const cmd = typeof input.command === "string" ? input.command : "";
          const cdMatch = cmd.match(/^cd\s+["']?([^"';&|]+)/);
          if (cdMatch) add(cdMatch[1].trim());
          break;
        }
        default:
          break;
      }
    }
  }
  return [...seen.entries()].map(([path, line]) =>
    line ? { path, line } : { path }
  );
}

/**
 * Detect whether Claude's last message is asking the user for input.
 *
 * Key insight: numbered lists alone are NOT attention — Claude often
 * summarises work as numbered items. Attention requires a question
 * signal (question mark or question phrase) alongside options.
 */
export function detectAttention(text) {
  if (!text) return false;
  const trimmed = text.trimEnd();
  const lower = trimmed.toLowerCase();

  const lines = trimmed.split("\n").filter(l => l.trim());
  const lastLine = lines[lines.length - 1] || "";
  const endsWithQuestion = lastLine.trimEnd().endsWith("?");

  const questionPhrases = [
    "would you like", "do you want", "shall i", "should i",
    "which option", "please choose", "please select",
    "let me know", "what would you prefer", "which would you prefer",
    "which approach", "what do you think",
  ];
  const hasQuestionPhrase = questionPhrases.some(p => lower.includes(p));

  return endsWithQuestion || hasQuestionPhrase;
}

/**
 * Parse the model's response into objective + narrative. Expected format:
 *   OBJECTIVE: <text>
 *   ---
 *   <markdown narrative>
 * If the divider is missing, treat the whole response as narrative (the
 * model sometimes skips the header when the objective hasn't changed).
 */
export function parseResponse(text) {
  const divider = text.indexOf("\n---");
  if (divider === -1) {
    return { objective: null, narrative: text };
  }

  const top = text.slice(0, divider).trim();
  const bottom = text.slice(divider + 4).trim();

  let objective = null;
  const objMatch = top.match(/^OBJECTIVE:\s*(.+)/i);
  if (objMatch) objective = objMatch[1].trim();

  return { objective, narrative: bottom || null };
}

/**
 * Build the user prompt handed to Ollama. The rolling summary is prepended
 * as context so the model knows "where it left off."
 */
export function buildPrompt(entries, summary) {
  const parts = [];
  if (summary) parts.push(`NARRATIVE SO FAR:\n${summary}\n`);
  parts.push(`TRANSCRIPT SLICE:\n${JSON.stringify(entries, null, 2)}`);
  parts.push("\nWrite the next narrative chunk (2-6 sentences, markdown). Output ONLY the markdown, no preamble.");
  return parts.join("\n");
}

/**
 * Extend a rolling summary with a new chunk, capped at MAX_SUMMARY_LENGTH.
 * Oldest content is dropped first — we want freshest context per-prompt.
 */
export function updateSummary(existing, newChunk) {
  const combined = existing ? `${existing}\n\n${newChunk}` : newChunk;
  if (combined.length <= MAX_SUMMARY_LENGTH) return combined;
  return combined.slice(combined.length - MAX_SUMMARY_LENGTH);
}

/**
 * Re-export readTranscriptEntries so callers have a single "read a slice"
 * door. The narrator accepts pre-read entries, but most callers will want
 * this helper to produce them.
 */
export { readTranscriptEntries };
