/**
 * Tiny Ollama HTTP client.
 *
 * Keeps the Ollama dependency isolated in one place — callers hand us
 * a user prompt and system prompt, we POST to the local Ollama
 * /api/chat endpoint and return the assistant text. Nothing
 * streaming, no history management; each call is independent.
 *
 * Defaults target a local-host install. `OLLAMA_HOST` and
 * `OLLAMA_MODEL` env vars override — the host for remote / cloud
 * installs, the model for testing different backbones.
 */

const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
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
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Ollama responded ${res.status}: ${await res.text().catch(() => "(no body)")}`);
    }
    const data = await res.json();
    const content = data?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Ollama response missing message.content");
    }
    return content;
  };
}
