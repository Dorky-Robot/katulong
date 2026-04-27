/**
 * Tiny Ollama HTTP client with backend cascade.
 *
 * Callers hand us a user prompt + system prompt; we POST to an Ollama
 * `/api/chat` endpoint and return the assistant text as a single string.
 * Streaming is used internally so the network doesn't sit idle waiting
 * for slow models — callers still await one aggregated string.
 *
 * ## Cascade
 *
 * The client supports an ordered list of `backends`, each `{ name, host,
 * authToken, model }`. On each call:
 *
 *   1. If a cached "active" backend exists and its TTL hasn't expired,
 *      try it first (fast path — no probe).
 *   2. Otherwise, probe each backend in order via `GET /api/tags`. The
 *      first backend that's reachable AND lists the requested model
 *      becomes the active backend; we then issue the actual chat call.
 *   3. If the active backend's chat call fails (network error or 4xx/5xx),
 *      invalidate the cache and probe the rest of the list. The same
 *      call may end up served by a different backend.
 *
 * Probe is cheap (`GET /api/tags`); the chat call is expensive. We trust
 * "probe says reachable" → "chat will succeed." If a chat call fails
 * after a successful probe (rare — load, mid-stream upstream crash),
 * we move on. The summarizer + narrator already retry every cycle.
 *
 * Cached active backend has a TTL (`probeTtlMs`, default 5 minutes) so
 * we eventually re-probe and recover when a higher-priority backend
 * comes back online (e.g., the peer bridge restarts).
 *
 * ## Backward compatibility
 *
 * The pre-cascade API took `host`/`model`/`authToken`/`resolveEndpoint`
 * directly. Those still work — the constructor synthesizes a single-
 * backend list from them. New callers should pass `resolveBackends`
 * instead, returning the ordered list fresh on each call so config
 * changes apply without a server restart.
 */

import { log } from "./log.js";

const DEFAULT_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "gemma3n:e2b";
// Summaries are fire-and-forget background work — nothing blocks on
// them — so a long timeout is fine. Keep the ceiling generous to
// tolerate cold-start latency, slow networks, or a local CPU-only
// host chewing through a multi-paragraph response.
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_PROBE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FAIL_TTL_MS = 30 * 1000;

/**
 * Create a `callOllama` function. The returned function additionally
 * carries `getActiveBackend()` so callers (e.g., /health) can report
 * which backend is currently in use without forcing a probe.
 */
export function createOllamaClient({
  // New API
  resolveBackends = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  probeTtlMs = DEFAULT_PROBE_TTL_MS,
  failTtlMs = DEFAULT_FAIL_TTL_MS,
  // Old API (single backend) — kept for tests + any pre-cascade callers
  host = DEFAULT_HOST,
  model = DEFAULT_MODEL,
  authToken = null,
  resolveEndpoint = null,
  // Internal seam — tests substitute a stub fetch
  fetchImpl = fetch,
} = {}) {
  // Synthesize a single-backend resolver if the caller used the old API.
  const effectiveResolveBackends =
    resolveBackends ||
    (() => {
      const endpoint = resolveEndpoint ? resolveEndpoint() : null;
      return [
        {
          name: "single",
          host: endpoint?.host || host,
          authToken: endpoint?.authToken ?? authToken ?? null,
          model,
        },
      ];
    });

  let activeBackend = null;
  let activeUntil = 0;
  let lastLoggedActiveName = null;

  function noteActive(backend) {
    if (backend.name === lastLoggedActiveName) return;
    log.info("ollama backend selected", {
      name: backend.name,
      host: backend.host,
      model: backend.model,
      previous: lastLoggedActiveName,
    });
    lastLoggedActiveName = backend.name;
  }

  function noteAllUnreachable() {
    if (lastLoggedActiveName === null) return;
    log.warn("ollama: no backend reachable", { previous: lastLoggedActiveName });
    lastLoggedActiveName = null;
  }

  async function probeBackend(backend) {
    const headers = backend.authToken
      ? { Authorization: `Bearer ${backend.authToken}` }
      : {};
    try {
      const res = await fetchImpl(`${backend.host}/api/tags`, {
        headers,
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      if (!Array.isArray(data?.models)) return false;
      return data.models.some((m) => m?.name === backend.model);
    } catch {
      return false;
    }
  }

  async function callChatOnce(backend, userPrompt, systemPrompt) {
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });

    const headers = { "Content-Type": "application/json" };
    if (backend.authToken) headers.Authorization = `Bearer ${backend.authToken}`;

    const res = await fetchImpl(`${backend.host}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: backend.model, messages, stream: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(
        `Ollama responded ${res.status}: ${await res.text().catch(() => "(no body)")}`,
      );
    }
    if (!res.body) {
      throw new Error("Ollama response missing body");
    }

    // Ollama streams NDJSON; aggregate the message.content fragments.
    // Always cancel the reader on abort so the underlying socket closes.
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
  }

  function cacheActive(backend) {
    activeBackend = backend;
    activeUntil = Date.now() + probeTtlMs;
  }

  function invalidateActive() {
    activeBackend = null;
    activeUntil = Date.now() + failTtlMs;
  }

  async function callOllama(userPrompt, { systemPrompt } = {}) {
    // Fast path: try the cached active backend without re-probing.
    if (activeBackend && Date.now() < activeUntil) {
      try {
        return await callChatOnce(activeBackend, userPrompt, systemPrompt);
      } catch (err) {
        log.warn("ollama: active backend failed, falling back", {
          name: activeBackend.name,
          error: err.message,
        });
        invalidateActive();
      }
    }

    // Slow path: probe each backend in order, use the first reachable
    // one that has the right model.
    const backends = effectiveResolveBackends();
    if (!Array.isArray(backends) || backends.length === 0) {
      throw new Error("ollama: no backends configured");
    }

    let lastErr = null;
    for (const backend of backends) {
      // Skip the cached active if we just failed it (avoids retrying
      // the same path twice in a single call).
      if (activeBackend === null && lastErr && backend.name === lastLoggedActiveName) {
        continue;
      }
      const reachable = await probeBackend(backend);
      if (!reachable) continue;
      try {
        const result = await callChatOnce(backend, userPrompt, systemPrompt);
        cacheActive(backend);
        noteActive(backend);
        return result;
      } catch (err) {
        lastErr = err;
        // Probe said yes but call failed — try the next backend.
      }
    }

    noteAllUnreachable();
    throw lastErr || new Error("ollama: no backend reachable");
  }

  callOllama.getActiveBackend = () =>
    activeBackend
      ? {
          name: activeBackend.name,
          host: activeBackend.host,
          model: activeBackend.model,
        }
      : null;

  /** Force the next call to re-probe (used by tests + on config change). */
  callOllama.invalidate = () => {
    activeBackend = null;
    activeUntil = 0;
  };

  return callOllama;
}
