/**
 * Narrative Processor
 *
 * Transforms raw Claude Code hook events into a running narrative —
 * a conversational, blog-like stream with prose, code snippets, and
 * observations. Uses a local Ollama model to process batches of
 * accumulated events into markdown narrative chunks.
 *
 * Architecture:
 *   Raw events arrive one at a time via ingest(). They accumulate in
 *   a per-topic buffer. On trigger (Stop events, buffer threshold),
 *   the buffer is flushed to Ollama for narrative synthesis. The
 *   resulting markdown is published back to the same topic as a
 *   status="narrative" event that the feed tile renders as rich content.
 *
 * Conversation continuity:
 *   Each topic maintains a rolling summary so the model has context of
 *   the entire session, not just the latest batch. The summary is
 *   updated with each narrative chunk.
 */

import { log as logger } from "./log.js";

const BATCH_THRESHOLD = 8;       // flush after N events
const FLUSH_DELAY_MS = 5000;     // debounce after trigger event
const MAX_SUMMARY_LENGTH = 2000; // rolling summary cap
const OLLAMA_TIMEOUT_MS = 60000; // max wait for ollama response
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:31b-cloud";

const SYSTEM_PROMPT = `You are a narrator for a live coding session. You receive batches of raw tool-use events from a Claude Code session and transform them into a running narrative — like a developer's blog post being written in real time.

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
 * Per-topic state for narrative processing.
 */
class TopicNarrative {
  constructor(topic) {
    this.topic = topic;
    this.buffer = [];
    this.summary = "";
    this.objective = "";
    this.flushTimer = null;
    this.flushing = false;
    // Stash of the most recent hook payload — used by ensureTopicMeta
    // when we lazily create the topic on first publish.
    this.lastPayload = null;
    this.metaReady = false;
  }
}

export function createNarrativeProcessor({ topicBroker, ensureTopicMeta, maxConcurrent = 1 }) {
  const topics = new Map();
  let enabled = true;
  let activeCalls = 0;

  function getOrCreate(topic) {
    let tn = topics.get(topic);
    if (!tn) {
      tn = new TopicNarrative(topic);
      topics.set(topic, tn);
    }
    return tn;
  }

  // Lazy publisher: creates the topic (via ensureTopicMeta) the first time
  // something meaningful is about to be published. This is how sessions that
  // never produce narrative / attention / completion stay invisible.
  function publish(tn, message) {
    if (!tn.metaReady && ensureTopicMeta && tn.lastPayload) {
      ensureTopicMeta(tn.topic, tn.lastPayload);
      tn.metaReady = true;
    }
    topicBroker.publish(tn.topic, message);
  }

  /**
   * Ingest a raw event. Call this from the claude-events route handler.
   *
   * @param {string} topic - The topic name (e.g., "claude/{sessionId}")
   * @param {object} message - The transformed event message (step/status/detail/event/tool)
   * @param {object} payload - The original hook payload (for extra context)
   */
  function ingest(topic, message, payload) {
    if (!enabled) return;

    const tn = getOrCreate(topic);
    tn.lastPayload = payload;

    // PreToolUse events mean Claude is waiting for tool approval
    if (message.event === "PreToolUse" && payload.tool_name) {
      const tool = payload.tool_name;
      const target = message.step || tool;
      publish(tn, JSON.stringify({
        step: `Approve **${tool}**: \`${target}\`?\n\n1. Yes\n2. No`,
        status: "attention",
        detail: "",
        event: "Attention",
        tool,
      }));
    }

    // Stop events produce an immediate completion or attention card
    // (separate from the Ollama narrative pipeline)
    if (message.event === "Stop") {
      const text = typeof payload.last_assistant_message === "string"
        ? payload.last_assistant_message
        : (message.detail || "");
      publishStopCard(tn, text);
    }

    // Build a compact event summary for the batch
    const entry = {
      event: message.event,
      step: message.step,
      status: message.status,
      detail: message.detail || undefined,
      tool: message.tool || undefined,
    };

    // Add extra context from payload when available
    if (payload.tool_input && message.tool) {
      entry.input = compactInput(message.tool, payload.tool_input);
    }
    if (payload.tool_response) {
      const resp = compactResponse(payload.tool_response);
      if (resp) entry.response = resp;
    }

    tn.buffer.push(entry);

    // Trigger events flush immediately (with debounce)
    const isTrigger = message.event === "Stop" ||
                      message.event === "SessionEnd" ||
                      tn.buffer.length >= BATCH_THRESHOLD;

    if (isTrigger) {
      scheduleFlush(tn);
    }
  }

  /**
   * Publish an immediate completion or attention card from a Stop event.
   * Determines whether Claude finished or is asking the user something.
   * Returns early (without publishing, and thus without creating the topic)
   * when Stop has no text — that's the /clear / empty-session case.
   */
  function publishStopCard(tn, text) {
    if (!text) return;

    const needsAttention = detectAttention(text);

    if (needsAttention) {
      publish(tn, JSON.stringify({
        step: text,
        status: "attention",
        detail: "",
        event: "Attention",
        tool: null,
      }));
    } else {
      // Truncate to a reasonable summary length
      const summary = text.length > 500 ? text.slice(0, 497) + "…" : text;
      publish(tn, JSON.stringify({
        step: summary,
        status: "completion",
        detail: "",
        event: "Completion",
        tool: null,
      }));
    }
  }

  function scheduleFlush(tn) {
    if (tn.flushTimer) clearTimeout(tn.flushTimer);
    tn.flushTimer = setTimeout(() => flush(tn), FLUSH_DELAY_MS);
  }

  async function flush(tn) {
    if (tn.flushing || tn.buffer.length === 0) return;

    // Global concurrency cap — drop this flush if at capacity.
    // Events stay in the buffer and will be picked up next time.
    if (activeCalls >= maxConcurrent) {
      logger.info("narrative-processor", `Skipping flush for ${tn.topic} — ${activeCalls}/${maxConcurrent} calls active`);
      // Reschedule so the buffer eventually drains
      scheduleFlush(tn);
      return;
    }

    tn.flushing = true;
    tn.flushTimer = null;

    const batch = tn.buffer.splice(0);

    // Empty-session filter — a batch made entirely of SessionStart / SessionEnd
    // (or bookkeeping events with no user prompt and no tool use) has nothing
    // worth narrating. Skip the Ollama call so we don't spend tokens, and more
    // importantly so we don't lazy-create a topic for a session that did
    // nothing. This is what kills the /clear and /resume junk feeds.
    if (!hasRealWork(batch)) {
      tn.flushing = false;
      return;
    }

    activeCalls++;
    const prompt = buildPrompt(batch, tn.summary);

    try {
      const raw = await callOllama(prompt);
      if (raw && raw.trim()) {
        const { objective, narrative } = parseResponse(raw.trim());

        if (narrative) {
          // Extract unique file paths touched in this batch
          const files = extractFiles(batch);

          // Publish the narrative chunk
          publish(tn, JSON.stringify({
            step: narrative,
            status: "narrative",
            detail: "",
            event: "Narrative",
            tool: null,
            files,
          }));

          // Update rolling summary
          tn.summary = updateSummary(tn.summary, narrative);
        }

        if (objective && objective !== tn.objective) {
          tn.objective = objective;
          // Publish updated session objective as a sticky summary
          publish(tn, JSON.stringify({
            step: objective,
            status: "summary",
            detail: "",
            event: "Summary",
            tool: null,
          }));
        }
      }
    } catch (err) {
      logger.warn("narrative-processor", `Failed to generate narrative for ${tn.topic}: ${err.message}`);
      // Put events back so they're not lost
      tn.buffer.unshift(...batch);
    } finally {
      activeCalls--;
      tn.flushing = false;
      // If more events arrived while flushing, schedule another
      if (tn.buffer.length > 0) scheduleFlush(tn);
    }
  }

  function buildPrompt(batch, summary) {
    const parts = [];
    if (summary) {
      parts.push(`NARRATIVE SO FAR:\n${summary}\n`);
    }
    parts.push(`NEW EVENTS:\n${JSON.stringify(batch, null, 2)}`);
    parts.push("\nWrite the next narrative chunk (2-6 sentences, markdown). Output ONLY the markdown, no preamble.");
    return parts.join("\n");
  }

  /**
   * Call Ollama's /api/chat endpoint. Returns the markdown response text.
   */
  async function callOllama(userPrompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json();
      return data.message?.content || "";
    } finally {
      clearTimeout(timer);
    }
  }

  function updateSummary(existing, newChunk) {
    const combined = existing
      ? `${existing}\n\n${newChunk}`
      : newChunk;

    // If under limit, keep as-is
    if (combined.length <= MAX_SUMMARY_LENGTH) return combined;

    // Truncate from the front, keeping the most recent content
    return combined.slice(combined.length - MAX_SUMMARY_LENGTH);
  }

  function destroy() {
    enabled = false;
    for (const tn of topics.values()) {
      if (tn.flushTimer) clearTimeout(tn.flushTimer);
    }
    topics.clear();
  }

  return { ingest, destroy };
}

/**
 * Parse the model's response into objective + narrative.
 * Expected format:
 *   OBJECTIVE: <text>
 *   ---
 *   <markdown narrative>
 */
function parseResponse(text) {
  const divider = text.indexOf("\n---");
  if (divider === -1) {
    // No divider — treat entire response as narrative
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
 * Extract unique file paths (with optional line numbers) from a batch.
 * Returns Array<{ path: string, line?: number }>.
 *
 * Line numbers come from:
 *   - Read tool: input.offset (the starting line)
 *   - Edit tool: parse tool_response for line mentions
 *   - Grep response: "filename:linenum:" patterns
 */
function extractFiles(batch) {
  // Map path → best line number seen (first wins)
  const seen = new Map();

  function add(path, line) {
    if (!path || typeof path !== "string") return;
    if (!seen.has(path)) {
      seen.set(path, typeof line === "number" && line > 0 ? line : undefined);
    }
  }

  for (const entry of batch) {
    // File path from Read/Write/Edit tool input
    const file = entry.input?.file;
    if (file) {
      add(file, entry.input?.line);
      continue;
    }
    // Grep/Glob path
    const path = entry.input?.path;
    if (path && typeof path === "string" && !path.includes("*")) {
      // Try to extract line from grep response ("filename:123:")
      let grepLine;
      if (entry.response && typeof entry.response === "string") {
        const m = entry.response.match(/:(\d+):/);
        if (m) grepLine = parseInt(m[1], 10);
      }
      add(path, grepLine);
      continue;
    }
    // Bash commands that reference paths (cd, ls)
    const cmd = entry.input?.cmd;
    if (cmd && typeof cmd === "string") {
      const cdMatch = cmd.match(/^cd\s+["']?([^"';&|]+)/);
      if (cdMatch) { add(cdMatch[1].trim()); continue; }
    }
    // Fall back to step text like "Read feed.js" / "Edit index.html"
    const step = entry.step;
    if (step && typeof step === "string" && entry.tool) {
      const m = step.match(/^(?:Read|Edit|Write)\s+(.+)/);
      if (m) add(m[1].trim());
    }
  }
  return [...seen.entries()].map(([path, line]) =>
    line ? { path, line } : { path }
  );
}

/**
 * Does this batch contain anything worth narrating? Sessions that only
 * emit SessionStart / SessionEnd (e.g., /clear, /resume, cancelled prompts)
 * or that emit a single Stop with no content are noise. We treat
 * UserPromptSubmit (non-empty) or any PostToolUse as evidence of real work.
 */
function hasRealWork(batch) {
  for (const e of batch) {
    if (e.event === "PostToolUse") return true;
    if (e.event === "UserPromptSubmit" && e.step && !e.step.includes("(empty)")) return true;
  }
  return false;
}

// --- Helpers to compact payloads for the LLM ---

function compactInput(tool, input) {
  if (!input || typeof input !== "object") return undefined;
  switch (tool) {
    case "Read":
      return { file: input.file_path, line: input.offset || undefined };
    case "Write":
      return { file: input.file_path };
    case "Edit":
      return { file: input.file_path };
    case "Bash":
      return { cmd: (input.command || "").slice(0, 200) };
    case "Grep":
      return { pattern: input.pattern, path: input.path };
    case "Glob":
      return { pattern: input.pattern };
    case "Agent":
      return { desc: input.description, type: input.subagent_type };
    default:
      return undefined;
  }
}

function compactResponse(resp) {
  if (!resp) return undefined;
  const str = typeof resp === "string" ? resp
    : resp.stdout || resp.content || resp.result || "";
  if (!str || typeof str !== "string") return undefined;
  return str.slice(0, 300);
}

/**
 * Detect whether Claude's last message is asking the user for input.
 * Returns true if the message looks like a question or choice prompt.
 *
 * Key insight: numbered lists alone are NOT attention — Claude often
 * summarises work as numbered items. Attention requires a question
 * signal (question mark, question phrase) alongside options.
 */
function detectAttention(text) {
  if (!text) return false;
  const trimmed = text.trimEnd();
  const lower = trimmed.toLowerCase();

  // Check for question signals
  const lines = trimmed.split("\n").filter(l => l.trim());
  const lastLine = lines[lines.length - 1] || "";
  const endsWithQuestion = lastLine.trimEnd().endsWith("?");

  const questionPhrases = [
    "would you like", "do you want", "shall i", "should i",
    "which option", "please choose", "please select",
    "let me know", "what would you prefer", "which approach",
    "what do you think",
  ];
  const hasQuestionPhrase = questionPhrases.some(p => lower.includes(p));

  // A question mark or question phrase is sufficient
  if (endsWithQuestion || hasQuestionPhrase) return true;

  return false;
}
