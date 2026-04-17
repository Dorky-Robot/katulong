/**
 * Minimal Ollama chat client — one async function, no state.
 *
 * Kept deliberately small so it can be injected into the narrator/processor
 * as a plain function for testing. The real network-backed call lives here;
 * tests substitute a fake that resolves a canned string.
 *
 * OLLAMA_URL / OLLAMA_MODEL can be overridden via environment; defaults target
 * a local instance on the standard port.
 */

const DEFAULT_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "gemma4:31b-cloud";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Create a `callOllama` function bound to a given URL/model/timeout.
 *
 * Returned function signature:
 *   (userPrompt: string, { systemPrompt?: string }) => Promise<string>
 *
 * On non-2xx responses or timeouts it throws — callers decide whether to
 * retry (the narrator surfaces errors; the processor logs and skips advance).
 */
export function createOllamaClient({
  url = DEFAULT_URL,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return async function callOllama(userPrompt, { systemPrompt } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const messages = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
      messages.push({ role: "user", content: userPrompt });

      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model, stream: false, messages }),
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
  };
}
