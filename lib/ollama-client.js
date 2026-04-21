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
 * The host still defaults to a local Ollama install (the cloud models
 * are served through the same local daemon once you're signed in).
 * `OLLAMA_HOST` and `OLLAMA_MODEL` env vars override.
 */

const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
// gemma4:31b-cloud is the project default. Local backbones we tried
// (gemma3n:e2b, qwen2.5-coder:7b) were too resource-intensive on
// laptop-class hosts — the model swapped out between prompts, and the
// feed narrator / session summarizer ran for minutes per summary.
// Routing through Ollama's cloud offload keeps the same client API
// while moving compute off the host. Override via OLLAMA_MODEL if you
// want to test a different backbone.
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "gemma4:31b-cloud";
// Summaries are fire-and-forget background work — nothing blocks on
// them — so a long timeout is fine. Cloud roundtrips are usually well
// under a minute, but keep the ceiling generous so a slow network or
// cold-start doesn't drop work we're about to get.
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
    //
    // We always cancel the reader in a finally — on abort (timeout /
    // caller-initiated), reader.read() rejects but the underlying
    // ReadableStream and its fetch body are not released until someone
    // explicitly cancels or fully drains. A cancel here detaches the
    // stream from the connection so undici can close the socket.
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

    let drained = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { drained = true; break; }
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          consumeLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      buf += decoder.decode();
      if (buf) consumeLine(buf);
    } finally {
      if (!drained) {
        try { await reader.cancel(); } catch { /* already closed */ }
      }
    }

    if (typeof content !== "string" || content.length === 0) {
      throw new Error("Ollama response missing message.content");
    }
    return content;
  };
}
