/**
 * Claude narrator — asks Ollama for a one-line title summarizing a single
 * Claude reply. That title becomes the collapsed-card label in the feed
 * (replacing the generic "Claude's reply (N words)" fallback).
 *
 * This is intentionally small. Earlier iterations also produced multi-
 * paragraph narrative blocks and a rolling summary/objective, which the
 * feed rendered as separate events. That model interleaved poorly with
 * the raw replies (narrative blocks landed when Ollama finished, not when
 * the underlying events happened) and duplicated information the user
 * already had in the reply text. The new feed shape is: one card per
 * reply, title progressively enhanced by Ollama — no narrative events,
 * no objective events, no summary events.
 *
 * The module is pure: no I/O, no state, no broker coupling. The processor
 * calls `summarizeReply` and decides what to do with the result (publish a
 * title-enrichment event, drop it on error, skip entirely when paused).
 */

const MAX_TITLE_CHARS = 140;

export const SYSTEM_PROMPT = `You write one-line titles for Claude Code replies, like subject lines for a stream of short updates.

Rules:
- Exactly one line. No bullet points, no markdown, no quotes.
- Plain English. No backticks or code formatting.
- 4–14 words. Aim short.
- Describe what Claude is doing or saying — not "Claude's reply about X", just the X.
- Present tense. No leading "This reply ...", "In this message ...", etc.
- If the reply asks the user a question, phrase the title as the question.
- Never mention that you are summarizing, narrating, or compressing.

Output ONLY the title line. No preamble, no trailing period unless it's a question.`;

/**
 * Generate a one-line title for a single Claude reply.
 *
 * Throws if callOllama throws — caller is responsible for deciding whether
 * to retry or skip. A resolution to empty/whitespace/unusable text returns
 * null so the caller can treat it the same as an Ollama-down case.
 *
 * @param {string} text            the full assistant reply text
 * @param {function} callOllama    async (userPrompt, { systemPrompt }) => string
 * @returns {Promise<string | null>} the title, trimmed to MAX_TITLE_CHARS, or null
 */
export async function summarizeReply(text, callOllama) {
  if (typeof callOllama !== "function") throw new Error("summarizeReply: callOllama is required");
  if (typeof text !== "string" || !text.trim()) return null;

  const userPrompt = `CLAUDE REPLY:\n${text}\n\nWrite the one-line title.`;
  const raw = await callOllama(userPrompt, { systemPrompt: SYSTEM_PROMPT });
  if (typeof raw !== "string") return null;

  // Ollama sometimes wraps the title in quotes or prefixes it with "Title:".
  // Strip the obvious ones so the stored label reads naturally.
  let line = raw.trim().split("\n")[0].trim();
  line = line.replace(/^["'`“‘]+|["'`”’]+$/g, "").trim();
  line = line.replace(/^(title|subject|headline)\s*[:\-—]\s*/i, "").trim();
  if (!line) return null;

  if (line.length > MAX_TITLE_CHARS) line = line.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + "…";
  return line;
}

// Re-export readTranscriptEntries so callers that used to reach for the
// narrator-plus-reader combo still have a single "read a slice" door.
export { readTranscriptEntries } from "./claude-event-transform.js";
