/**
 * Tiny Ollama HTTP client.
 *
 * Keeps the Ollama dependency isolated in one place — callers hand us
 * a user prompt and system prompt, we POST to the local Ollama
 * /api/chat endpoint and return the assistant text as a single string.
 *
 * Uses Ollama's streaming mode (`stream: true`) under the hood so the
 * response headers and first chunk arrive promptly, even when the
 * model takes minutes to finish. Non-streaming mode buffers the full
 * JSON response server-side, which trips undici's 5-minute
 * `headersTimeout` on CPU-only hosts running 7B-class models — the
 * outward behaviour from callers' perspective is unchanged (they
 * still await one string), but the network path no longer sits idle
 * waiting for a completed response.
 *
 * Defaults target a local-host install. `OLLAMA_HOST` and
 * `OLLAMA_MODEL` env vars override — the host for remote / cloud
 * installs, the model for testing different backbones.
 */

const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
// gemma3n:e2b is the project default: it stays resident in ~2–3 GB of
// RAM where qwen2.5-coder:7b needs ~5 GB and forces the OS to swap the
// model out between prompts on a laptop-class host. The smaller model
// finishes a short-prompt reply in well under a minute, which is what
// the feed narrator and session summarizer need. Override via the
// OLLAMA_MODEL env var if you want a different backbone.
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "gemma3n:e2b";
// Summaries are fire-and-forget background work — nothing blocks on
// them — so a long timeout is fine. 7B-class models on CPU-only hosts
// commonly take 2–4 minutes for a multi-paragraph response; set the
// ceiling well above that so we don't drop work we're about to get.
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Create a `callOllama` function bound to a given URL/model/timeout.
 * Returns `async (userPrompt, { systemPrompt }) => string`.
 */
export function createOllamaClient({
  host = DEFAULT_HOST,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return async function callOllama(userPrompt, { systemPrompt } = {}) {
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });

    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Ollama responded ${res.status}: ${await res.text().catch(() => "(no body)")}`);
    }
    if (!res.body) {
      throw new Error("Ollama response missing body");
    }

    // Ollama streams NDJSON: one JSON object per newline, each with an
    // incremental `message.content` fragment, terminated by a final
    // `{"done": true, ...}` object. Aggregate the content fragments.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { return; }
      const piece = obj?.message?.content;
      if (typeof piece === "string") content += piece;
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        consumeLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    if (buf) consumeLine(buf);

    if (typeof content !== "string" || content.length === 0) {
      throw new Error("Ollama response missing message.content");
    }
    return content;
  };
}
