/**
 * Session summarizer — auto-generates a short title and one-sentence
 * summary for every live katulong session based on its recent terminal
 * output. Writes the result to `session.meta.autoTitle` (short label
 * for the tab) and `session.meta.summary` (`{ short, long, updatedAt }`
 * for the tab tooltip).
 *
 * Why this exists: tab labels default to the tmux session name
 * (`kat_xxx…`), which is useless as a hint of "what is this tab for."
 * The summarizer gives every session a human-readable name and
 * hover-tooltip regardless of whether Claude is running — a generic
 * core feature, not coupled to the Claude feed. Claude sessions still
 * get their richer transcript-driven summary on `meta.claude.summary`,
 * which the feed tile renders; the two signals live in separate
 * namespaces and don't contend.
 *
 * Sliding window: each cycle reads the tail of the session's
 * RingBuffer (`windowBytes`). The summary reflects the tab's *recent*
 * purpose — not a historical average — because a tab's purpose
 * changes over time (edit → run server → debug → …). Older context
 * ages out naturally as the PTY emits new bytes.
 *
 * Change detection: hashes the stripped window and skips Ollama when
 * the hash is unchanged. An idle tab costs one SHA-1 per cycle and
 * nothing else. The hash is kept in memory, so a server restart
 * forces one "first" summary on each session — which is the
 * behaviour we want: after restart, the tooltip repopulates as soon
 * as each session has enough buffered output.
 *
 * Sufficient-data guard: sessions with less than `minContentChars`
 * of printable content in the window are skipped. A freshly-opened
 * shell sitting at a prompt shouldn't wake Ollama; wait until it has
 * produced something worth summarizing.
 *
 * User override: a user-set title lives on `session.meta.userTitle`
 * (set via a session-rename action, outside this module's concern).
 * The summarizer never touches userTitle; the frontend picks
 * `userTitle ?? autoTitle ?? sessionName` when rendering the tab.
 */

import { createHash } from "node:crypto";
import { log } from "./log.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_WINDOW_BYTES = 8000;
const DEFAULT_SCROLLBACK_LINES = 500;
const DEFAULT_MIN_CONTENT_CHARS = 400;
const MAX_TITLE_LEN = 60;
const MAX_SUMMARY_LEN = 300;
// Cap the ring so an always-on session doesn't grow meta.summaryHistory
// unbounded. 40 entries at a 30s cycle is ~20 minutes of distinct work
// phases, which is the window the user actually forgets over.
const MAX_HISTORY_ENTRIES = 40;

const SYSTEM_PROMPT =
  "You describe the purpose of a terminal session from its recent " +
  "output. Answer in strict JSON with exactly two keys: \"title\" " +
  "(3–6 words, title case, no quotes) and \"summary\" (one sentence, " +
  "present tense). No prose outside the JSON.";

// Minimal ANSI stripper — enough to denoise the model prompt. Covers
// CSI (\e[…), OSC (\e]…BEL or ST), and 2-byte escapes (ESC <letter>).
// A perfect stripper would have to parse the VT protocol; the model
// doesn't need perfection, just fewer control bytes.
function stripAnsi(s) {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, "")
    // Remaining bare control chars (BEL, backspace, etc.) — keep
    // newlines and tabs for readability.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function hashWindow(text) {
  return createHash("sha1").update(text).digest("hex");
}

function clamp(value, maxLen) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1).trimEnd() + "…";
}

/**
 * Parse Ollama's response. Accepts strict JSON or JSON embedded in
 * fenced code blocks / prose — small models like gemma3n sometimes
 * wrap their output. Returns null if no well-formed object with
 * string `title` and `summary` fields can be extracted.
 */
export function parseSummaryResponse(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const title = clamp(obj.title, MAX_TITLE_LEN);
  const summary = clamp(obj.summary, MAX_SUMMARY_LEN);
  if (!title || !summary) return null;
  return { title, summary };
}

/**
 * Build a session summarizer bound to a session manager + Ollama client.
 *
 * @param {object} opts
 * @param {object} opts.sessionManager - must expose listSessions(), getSession(name)
 * @param {function} opts.callOllama    - async (userPrompt, { systemPrompt }) => string
 * @param {number} [opts.pollIntervalMs=30000]
 * @param {number} [opts.windowBytes=8000] - max tail bytes fed into the hash + prompt
 * @param {number} [opts.minContentChars=400] - below this, skip the session entirely
 */
export function createSessionSummarizer({
  sessionManager,
  callOllama,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  windowBytes = DEFAULT_WINDOW_BYTES,
  scrollbackLines = DEFAULT_SCROLLBACK_LINES,
  minContentChars = DEFAULT_MIN_CONTENT_CHARS,
}) {
  if (!sessionManager) {
    throw new Error("createSessionSummarizer: sessionManager is required");
  }
  if (typeof callOllama !== "function") {
    throw new Error("createSessionSummarizer: callOllama is required");
  }

  // Per-session state: { lastHash, inFlight }. Keyed by session name
  // (unique within a manager). Cleared on stop() and on session
  // removal (garbage-collected when listSessions stops reporting it).
  const state = new Map();
  let timer = null;
  let stopped = false;

  // Prefer tmux's own scrollback when the session exposes `captureScrollback`
  // — this survives server restarts because tmux retains pane history even
  // when the katulong RingBuffer starts empty (control mode only streams
  // NEW output on reattach). The RingBuffer `pullTail` stays as a fallback
  // so tests (and any session surface that doesn't implement the capture
  // shim) still work.
  async function extractWindow(session) {
    if (typeof session.captureScrollback === "function") {
      const raw = await session.captureScrollback(scrollbackLines);
      if (raw && raw.length > 0) return stripAnsi(raw);
    }
    if (typeof session.pullTail === "function") {
      const { data } = session.pullTail(windowBytes);
      if (data) return stripAnsi(data);
    }
    return "";
  }

  async function summarizeOne(session) {
    const name = session.name;
    let st = state.get(name);
    if (!st) {
      st = { lastHash: null, inFlight: false };
      state.set(name, st);
    }
    if (st.inFlight) return;

    const window = await extractWindow(session);
    if (window.length < minContentChars) return;

    const hash = hashWindow(window);
    if (hash === st.lastHash) return;

    st.inFlight = true;
    try {
      const raw = await callOllama(window, { systemPrompt: SYSTEM_PROMPT });
      const parsed = parseSummaryResponse(raw);
      if (!parsed) {
        log.warn("session-summarizer: unparseable response", { session: name });
        return;
      }

      // Session may have been destroyed while we were waiting on Ollama.
      const live = sessionManager.getSession(name);
      if (!live || !live.alive) return;

      const at = Date.now();
      live.setMeta("summary", {
        short: parsed.title,
        long: parsed.summary,
        updatedAt: at,
      });
      live.setMeta("autoTitle", parsed.title);

      // Append to the rolling history so a user who forgets "what was
      // I doing 10 minutes ago" can scroll back. We append only when
      // the title OR summary actually changed — consecutive identical
      // outputs on the same content window happen when Ollama is
      // stable, and recording them would flood the ring with dupes.
      const history = Array.isArray(live.meta?.summaryHistory)
        ? live.meta.summaryHistory
        : [];
      const last = history.length > 0 ? history[history.length - 1] : null;
      const duplicate = last
        && last.title === parsed.title
        && last.summary === parsed.summary;
      if (!duplicate) {
        const next = history.concat([{ title: parsed.title, summary: parsed.summary, at }]);
        // Ring: drop oldest once we exceed the cap.
        while (next.length > MAX_HISTORY_ENTRIES) next.shift();
        live.setMeta("summaryHistory", next);
      }
      st.lastHash = hash;
      log.info("session-summarizer: summary updated", {
        session: name, title: parsed.title,
      });
    } catch (err) {
      log.warn("session-summarizer: cycle failed", { session: name, error: err.message });
    } finally {
      st.inFlight = false;
    }
  }

  function pruneRemoved() {
    const { sessions } = sessionManager.listSessions();
    const alive = new Set((sessions || []).map((s) => s.name));
    for (const name of state.keys()) {
      if (!alive.has(name)) state.delete(name);
    }
  }

  async function tick() {
    if (stopped) return;
    pruneRemoved();
    const { sessions } = sessionManager.listSessions();
    for (const info of sessions || []) {
      if (!info.alive) continue;
      const live = sessionManager.getSession(info.name);
      if (!live) continue;
      // Fire-and-forget; per-session inFlight guard prevents pile-up.
      summarizeOne(live);
    }
    schedule();
  }

  function schedule(delay = pollIntervalMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }

  function start() {
    if (stopped) throw new Error("createSessionSummarizer: already stopped");
    log.info("session-summarizer: started", {
      pollIntervalMs, windowBytes, scrollbackLines, minContentChars,
    });
    // Run an immediate first cycle so restored sessions get a summary
    // within one Ollama round-trip instead of waiting a full poll
    // interval (up to 30s of empty tooltips) after a server restart.
    schedule(0);
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    state.clear();
  }

  return {
    start,
    stop,
    // Exposed for tests — runs one cycle synchronously-ish.
    runOnce: tick,
    _state: state,
  };
}
