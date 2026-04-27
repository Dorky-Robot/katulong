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
 * Host and model both have library-level defaults, but the product
 * decision of *which* model to use belongs at the call site — not
 * here — so callers in server.js pass `model` explicitly. The
 * `OLLAMA_HOST` / `OLLAMA_MODEL` env vars are last-resort overrides
 * for ad-hoc testing, not the normal configuration path.
 */

const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "gemma3n:e2b";
// Summaries are fire-and-forget background work — nothing blocks on
// them — so a long timeout is fine. Keep the ceiling generous to
// tolerate cold-start latency, slow networks, or a local CPU-only
// host chewing through a multi-paragraph response.
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Create a `callOllama` function bound to a given URL/model/timeout.
 * Returns `async (userPrompt, { systemPrompt }) => string`.
 *
 * `resolveEndpoint`, when provided, is called on every request and
 * returns `{ host, authToken }`. This lets the running server pick up
 * UI-driven config changes (peer URL + token) without a restart. When
 * absent, the static `host`/`authToken` from create-time are used.
 *
 * `authToken` (when set, either statically or via resolveEndpoint) is
 * sent as `Authorization: Bearer <token>`. This is the wire shape
 * ollama-bridge expects today and the eventual katulong-app/1 runtime
 * call will keep using.
 */
export function createOllamaClient({
  host = DEFAULT_HOST,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  authToken = null,
  resolveEndpoint = null,
} = {}) {
  return async function callOllama(userPrompt, { systemPrompt } = {}) {
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });

    const endpoint = resolveEndpoint ? resolveEndpoint() : null;
    const effectiveHost = endpoint?.host || host;
    const effectiveToken = endpoint?.authToken ?? authToken;

    const headers = { "Content-Type": "application/json" };
    if (effectiveToken) headers.Authorization = `Bearer ${effectiveToken}`;

    const res = await fetch(`${effectiveHost}/api/chat`, {
      method: "POST",
      headers,
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
