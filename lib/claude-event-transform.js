/**
 * Claude Event Transform
 *
 * Pure function that translates a Claude Code hook payload into a
 * feed-tile-friendly message (step/status/detail). No server deps,
 * no side effects — easy to test.
 *
 * Claude Code's hook system POSTs JSON on lifecycle events (PostToolUse,
 * Stop, SubagentStart/Stop, etc.). Each payload includes session_id and
 * hook_event_name. This module extracts a human-readable summary suitable
 * for the feed tile's progress rendering strategy.
 */

import { readFileSync, statSync } from "node:fs";

// Hard cap on transcript file size to protect the server from being asked to
// slurp a pathologically large JSONL into memory. 50 MB is well above any
// real Claude Code session; beyond that we refuse rather than OOM the host.
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

const MAX_DETAIL_LENGTH = 200;
// Anchored UUID: full-string match, used to validate session_id inputs.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract a short target description from tool_input.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string}
 */
function extractTarget(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";

  switch (toolName) {
    case "Edit":
    case "Read":
    case "Write":
      if (toolInput.file_path) return basename(toolInput.file_path);
      return "";
    case "Bash":
      if (toolInput.command) return truncate(toolInput.command, 40);
      return "";
    case "Grep":
    case "Glob":
      if (toolInput.pattern) return truncate(toolInput.pattern, 40);
      return "";
    case "Agent":
      if (toolInput.description) return truncate(toolInput.description, 40);
      return "";
    default:
      return "";
  }
}

function basename(filePath) {
  const i = filePath.lastIndexOf("/");
  return i >= 0 ? filePath.substring(i + 1) : filePath;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.substring(0, max - 1) + "\u2026";
}

/**
 * Extract a readable string from tool_response, which may be a string
 * or a structured object (e.g., Bash gives { stdout, stderr }).
 */
function extractToolResponse(resp) {
  if (!resp) return "";
  if (typeof resp === "string") return resp;
  if (typeof resp === "object") {
    // Bash tool: { stdout, stderr }
    if (resp.stdout) return resp.stdout;
    if (resp.stderr) return resp.stderr;
    // Generic: try common field names
    if (resp.content) return typeof resp.content === "string" ? resp.content : "";
    if (resp.result) return typeof resp.result === "string" ? resp.result : "";
  }
  return "";
}

function truncateDetail(str) {
  if (!str || typeof str !== "string") return "";
  // Take first line only, then truncate
  const firstLine = str.split("\n")[0];
  return truncate(firstLine, MAX_DETAIL_LENGTH);
}

/**
 * Transform a Claude Code hook payload into a feed event.
 *
 * @param {object} payload - Raw hook JSON from Claude Code
 * @returns {{ topic: string, message: object } | null} - null if payload is invalid or unhandled
 */
export function transformClaudeEvent(payload) {
  if (!payload || typeof payload !== "object") return null;

  const sessionId = payload.session_id;
  const event = payload.hook_event_name;
  if (!sessionId || !event) return null;
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return null;

  const topic = `claude/${sessionId}`;
  let step, status, detail;

  switch (event) {
    case "UserPromptSubmit": {
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      step = `User: ${truncate(prompt || "(empty)", 60)}`;
      status = "active";
      detail = "";
      break;
    }

    case "PreToolUse": {
      const tool = payload.tool_name || "Unknown";
      const target = extractTarget(tool, payload.tool_input);
      step = target ? `${tool} ${target}` : tool;
      status = "pending";
      detail = "";
      break;
    }

    case "PostToolUse": {
      const tool = payload.tool_name || "Unknown";
      const target = extractTarget(tool, payload.tool_input);
      step = target ? `${tool} ${target}` : tool;
      status = "done";
      detail = truncateDetail(extractToolResponse(payload.tool_response));
      break;
    }

    case "Stop": {
      step = "Claude responded";
      status = "done";
      detail = truncateDetail(
        typeof payload.last_assistant_message === "string"
          ? payload.last_assistant_message
          : ""
      );
      break;
    }

    case "SubagentStart": {
      const desc = payload.description || payload.agent_type || "subagent";
      step = `Subagent: ${truncate(desc, 50)}`;
      status = "active";
      detail = payload.agent_type || "";
      break;
    }

    case "SubagentStop": {
      const desc = payload.description || payload.agent_type || "subagent";
      step = `Subagent: ${truncate(desc, 50)}`;
      status = "done";
      detail = "";
      break;
    }

    case "SessionStart": {
      step = "Session started";
      status = "info";
      detail = payload.cwd || "";
      break;
    }

    case "SessionEnd": {
      step = "Session ended";
      status = "info";
      detail = "";
      break;
    }

    default:
      // Unhandled event type — still publish it as a generic log entry
      step = event;
      status = "info";
      detail = "";
      break;
  }

  return {
    topic,
    message: { step, status, detail, event, tool: payload.tool_name || null },
  };
}

// --- Transcript slice reading ---

const TRANSCRIPT_TEXT_MAX = 1000;
const TRANSCRIPT_RESULT_MAX = 500;

/**
 * Read transcript JSONL entries starting from a given line index and
 * return them as normalized, narrator-friendly records.
 *
 * This is the primary hook the narrative processor uses under the
 * thin-event model: the Claude transcript on disk is the source of
 * truth for what happened in a session, and the pub/sub only carries
 * synthesized output. Each flush advances a per-topic cursor, so we
 * read only the new slice of the transcript.
 *
 * Counting is by *significant* (non-blank) line number. Blank trailing
 * lines from the JSONL writer don't shift the cursor.
 *
 * @param {string} transcriptPath Absolute path to the JSONL transcript
 * @param {number} fromLine       Cursor: skip this many significant lines
 * @param {number} [limit]        Stop after reading this many significant
 *                                lines from `fromLine`. Omit for no cap.
 *                                When set, `nextCursor` points at the next
 *                                unread line so the caller can resume.
 *                                `hasMore` is true when we stopped early.
 * @returns {{ entries: object[], nextCursor: number, hasMore: boolean }}
 *   entries: normalized records with shape { role, text?, tools?, tool_result? }
 *   nextCursor: the new cursor value to persist for the next call
 *   hasMore: true when the limit cut the read short
 */
export function readTranscriptEntries(transcriptPath, fromLine = 0, limit) {
  if (!transcriptPath || typeof transcriptPath !== "string") {
    return { entries: [], nextCursor: fromLine, hasMore: false };
  }

  let raw;
  try {
    const st = statSync(transcriptPath);
    if (st.size > MAX_TRANSCRIPT_BYTES) {
      return { entries: [], nextCursor: fromLine, hasMore: false };
    }
    raw = readFileSync(transcriptPath, "utf8");
    // Re-check after read to close the TOCTOU window between stat and read
    // — the file could have grown past the cap between the two syscalls.
    if (Buffer.byteLength(raw) > MAX_TRANSCRIPT_BYTES) {
      return { entries: [], nextCursor: fromLine, hasMore: false };
    }
  } catch {
    return { entries: [], nextCursor: fromLine, hasMore: false };
  }

  const significant = raw.split("\n").filter(l => l.trim());
  if (fromLine >= significant.length) {
    return { entries: [], nextCursor: significant.length, hasMore: false };
  }

  const hasLimit = typeof limit === "number" && limit > 0;
  const end = hasLimit ? Math.min(significant.length, fromLine + limit) : significant.length;

  const entries = [];
  for (let i = fromLine; i < end; i++) {
    let obj;
    try { obj = JSON.parse(significant[i]); } catch { continue; }
    const normalized = normalizeTranscriptEntry(obj);
    if (normalized) entries.push(normalized);
  }
  return {
    entries,
    nextCursor: end,
    hasMore: end < significant.length,
  };
}

/**
 * Convert one raw transcript JSONL entry into a narrator-friendly record.
 * Returns null for entries we don't care about (session metadata, pure
 * thinking blocks, etc.) so the caller can ignore the noise.
 *
 * Shapes:
 *   user prompt     → { role: "user", text }
 *   tool result     → { role: "tool_result", text }
 *   assistant turn  → { role: "assistant", text?, tools?: [{ name, input }] }
 */
function normalizeTranscriptEntry(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = obj.type;
  const content = obj.message?.content;

  if (type === "user") {
    if (typeof content === "string") {
      return { role: "user", text: truncate(content, TRANSCRIPT_TEXT_MAX) };
    }
    if (!Array.isArray(content)) return null;

    // tool_result blocks mean this "user" entry is actually a tool response
    const toolResults = content.filter(b => b && b.type === "tool_result");
    if (toolResults.length > 0) {
      const text = toolResults.map(b => stringifyContent(b.content)).filter(Boolean).join("\n");
      if (!text) return null;
      return { role: "tool_result", text: truncate(text, TRANSCRIPT_RESULT_MAX) };
    }

    const text = content.filter(b => b && b.type === "text" && b.text)
      .map(b => b.text).join("\n");
    if (!text) return null;
    return { role: "user", text: truncate(text, TRANSCRIPT_TEXT_MAX) };
  }

  if (type === "assistant") {
    if (!Array.isArray(content)) return null;
    const text = content.filter(b => b && b.type === "text" && b.text)
      .map(b => b.text).join("\n");
    const tools = content.filter(b => b && b.type === "tool_use")
      .map(b => ({ name: b.name, input: b.input || {} }));
    if (!text && tools.length === 0) return null;
    const out = { role: "assistant" };
    if (text) out.text = truncate(text, TRANSCRIPT_TEXT_MAX);
    if (tools.length > 0) out.tools = tools;
    return out;
  }

  return null;
}

function stringifyContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter(b => b && b.type === "text" && b.text)
      .map(b => b.text).join("\n");
  }
  return "";
}
