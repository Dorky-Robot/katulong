/**
 * Narrative Processor
 *
 * Transforms a Claude Code session's transcript into a running narrative —
 * a conversational, blog-like stream with prose, code snippets, and
 * observations. Uses a local Ollama model to process new transcript
 * slices into markdown narrative chunks.
 *
 * Architecture (thin-event model):
 *   Hook events arrive via ingest() but are used only as triggers and for
 *   synchronous attention/completion cards. The actual narrative material
 *   is read from the Claude transcript JSONL on disk — that file is the
 *   source of truth for what happened. Each topic maintains a cursor (a
 *   line offset into the transcript) so every flush processes only the
 *   slice since the last synthesis. This gives the narrator richer,
 *   unlossy input than the hook payloads it used to receive.
 *
 * Conversation continuity:
 *   Each topic maintains a rolling summary so the model has context of
 *   the entire session, not just the latest slice. The summary is
 *   updated with each narrative chunk.
 */

import { log as logger } from "./log.js";
import { readTranscriptEntries } from "./claude-event-transform.js";

const BATCH_THRESHOLD = 8;       // flush after N trigger events
const FLUSH_DELAY_MS = 5000;     // debounce after trigger event
const MAX_SUMMARY_LENGTH = 2000; // rolling summary cap
const OLLAMA_TIMEOUT_MS = 60000; // max wait for ollama response
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:31b-cloud";

const SYSTEM_PROMPT = `You are a narrator for a live coding session. You receive slices of a Claude Code session transcript — user prompts, assistant reasoning and tool calls, and tool results — and transform them into a running narrative, like a developer's blog post being written in real time.

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
    this.summary = "";
    this.objective = "";
    this.flushTimer = null;
    this.flushing = false;
    // Stash of the most recent hook payload — used by ensureTopicMeta
    // when we lazily create the topic on first publish, and to resolve
    // the transcript path.
    this.lastPayload = null;
    this.metaReady = false;
    // Transcript cursor: index into the significant-line count of the
    // JSONL transcript. Advances only after a successful Ollama call, so
    // transient failures retry the same slice rather than dropping it.
    this.transcriptPath = null;
    this.transcriptCursor = 0;
    // Trigger accumulator — how many hook events have landed since the
    // last flush. We no longer keep the events themselves; the transcript
    // is canonical.
    this.pendingEvents = 0;
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
    if (!tn.transcriptPath && typeof payload.transcript_path === "string") {
      tn.transcriptPath = payload.transcript_path;
    }

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

    tn.pendingEvents += 1;

    // Trigger events schedule a flush (debounced). At flush time we read
    // the transcript slice since the last cursor — the hook events
    // themselves are not stored.
    const isTrigger = message.event === "Stop" ||
                      message.event === "SessionEnd" ||
                      tn.pendingEvents >= BATCH_THRESHOLD;

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
    if (tn.flushing) return;

    // Global concurrency cap — skip this flush if at capacity. The cursor
    // is not advanced and pendingEvents is preserved, so the slice will be
    // picked up on the next scheduled flush.
    if (activeCalls >= maxConcurrent) {
      logger.info("narrative-processor", `Skipping flush for ${tn.topic} — ${activeCalls}/${maxConcurrent} calls active`);
      scheduleFlush(tn);
      return;
    }

    tn.flushing = true;
    tn.flushTimer = null;

    const startCursor = tn.transcriptCursor;
    const { entries, nextCursor } = readTranscriptEntries(tn.transcriptPath, startCursor);

    // Nothing new on disk — nothing to narrate. Clear the trigger counter
    // and exit without creating a topic.
    if (entries.length === 0) {
      tn.pendingEvents = 0;
      tn.flushing = false;
      return;
    }

    // Empty-session filter — a slice with no user prompt and no assistant
    // tool use (e.g., /clear, /resume, cancelled turns) has nothing worth
    // narrating. Advance the cursor past the junk so we don't re-examine
    // these same entries forever, and exit without calling Ollama or
    // creating a topic.
    if (!hasRealWork(entries)) {
      tn.transcriptCursor = nextCursor;
      tn.pendingEvents = 0;
      tn.flushing = false;
      return;
    }

    activeCalls++;
    const prompt = buildPrompt(entries, tn.summary);

    try {
      const raw = await callOllama(prompt);
      if (raw && raw.trim()) {
        const { objective, narrative } = parseResponse(raw.trim());

        if (narrative) {
          const files = extractFiles(entries);

          publish(tn, JSON.stringify({
            step: narrative,
            status: "narrative",
            detail: "",
            event: "Narrative",
            tool: null,
            files,
          }));

          tn.summary = updateSummary(tn.summary, narrative);
        }

        if (objective && objective !== tn.objective) {
          tn.objective = objective;
          publish(tn, JSON.stringify({
            step: objective,
            status: "summary",
            detail: "",
            event: "Summary",
            tool: null,
          }));
        }
      }

      // Advance cursor only on a successful round-trip. If Ollama returned
      // an empty body we still advance — the model chose to say nothing
      // about this slice and we shouldn't re-feed it indefinitely.
      tn.transcriptCursor = nextCursor;
      tn.pendingEvents = 0;
    } catch (err) {
      logger.warn("narrative-processor", `Failed to generate narrative for ${tn.topic}: ${err.message}`);
      // Cursor is NOT advanced — the same slice will be retried on the
      // next flush. pendingEvents is also preserved so a subsequent
      // trigger event doesn't have to wait for a fresh threshold.
    } finally {
      activeCalls--;
      tn.flushing = false;
      if (tn.pendingEvents > 0) scheduleFlush(tn);
    }
  }

  function buildPrompt(entries, summary) {
    const parts = [];
    if (summary) {
      parts.push(`NARRATIVE SO FAR:\n${summary}\n`);
    }
    parts.push(`TRANSCRIPT SLICE:\n${JSON.stringify(entries, null, 2)}`);
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
 * Extract unique file paths (with optional line numbers) from the tool_use
 * blocks inside a transcript slice. Returns Array<{ path, line? }>.
 *
 * We walk assistant entries' `tools` arrays — each tool_use carries its
 * raw input, which is richer than any hook-payload-compacted form. Line
 * numbers come from Read.offset where available.
 */
function extractFiles(entries) {
  // Map path → first line number seen
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
          // Pull a cd target out of the command if there is one
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
 * Does this slice contain anything worth narrating? Sessions that only
 * emit session metadata (e.g., /clear, /resume, cancelled turns before
 * any work) produce no user prompt and no assistant activity. We treat a
 * user prompt with content or any assistant entry (text or tool use) as
 * evidence of real work.
 */
function hasRealWork(entries) {
  for (const e of entries) {
    if (e.role === "user" && e.text) return true;
    if (e.role === "assistant" && (e.text || (e.tools && e.tools.length > 0))) return true;
  }
  return false;
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
