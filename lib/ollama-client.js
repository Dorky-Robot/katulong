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
// When the active backend is a fallback (not the first/preferred entry),
// re-probe much more often so we notice when the higher-priority backend
// (e.g., a peer-bridge that just restarted) comes back online. Without
// this, a downed bridge would leave us pinned to local-31b/local-cloud
// for the full probeTtlMs (5 minutes).
const DEFAULT_FALLBACK_TTL_MS = 30 * 1000;

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
  fallbackTtlMs = DEFAULT_FALLBACK_TTL_MS,
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

  // Three pieces of state:
  //   cachedBackend  — the backend we trust right now (or null).
  //   cacheUntil     — when that trust expires (TTL after a successful call).
  //   quietUntil     — don't probe again before this (backoff after a complete
  //                     cascade failure). Distinct from cacheUntil so the two
  //                     post-failure states don't conflate: "we have an active
  //                     backend, just trust it" is different from "we just tried
  //                     everything and nothing worked, hold off."
  let cachedBackend = null;
  let cacheUntil = 0;
  let quietUntil = 0;
  let lastLoggedActiveName = null;

  function safeHost(host) {
    try {
      return new URL(host).origin;
    } catch {
      return "(unparseable)";
    }
  }

  function noteActive(backend) {
    if (backend.name === lastLoggedActiveName) return;
    log.info("ollama backend selected", {
      name: backend.name,
      host: safeHost(backend.host),
      model: backend.model,
      previous: lastLoggedActiveName,
    });
    lastLoggedActiveName = backend.name;
  }

  function noteAllUnreachable() {
    // Always log — operator wants to see the warning even on first call,
    // not just after a previously-active backend goes down.
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

  async function callOllama(userPrompt, { systemPrompt } = {}) {
    const now = Date.now();

    // Fast path: try the cached active backend without re-probing. Capture
    // the just-failed name BEFORE entering the slow path so we can skip it
    // there — without this, the slow path would re-probe the same backend
    // it just failed and possibly issue a second chat call.
    let justFailedName = null;
    if (cachedBackend && now < cacheUntil) {
      try {
        return await callChatOnce(cachedBackend, userPrompt, systemPrompt);
      } catch (err) {
        log.warn("ollama: active backend failed, falling back", {
          name: cachedBackend.name,
          error: err.message,
        });
        justFailedName = cachedBackend.name;
        cachedBackend = null;
        cacheUntil = 0;
      }
    }

    // Backoff: a complete cascade failure on the previous call set quietUntil.
    // Don't probe-storm during an outage; the caller (summarizer / narrator)
    // is calling on a 30-second-ish cycle and would otherwise probe every time.
    if (Date.now() < quietUntil) {
      throw new Error("ollama: in failure backoff, retrying after " +
        new Date(quietUntil).toISOString());
    }

    // Slow path: probe each backend in order, use the first reachable
    // one that has the right model.
    const backends = effectiveResolveBackends();
    if (!Array.isArray(backends) || backends.length === 0) {
      throw new Error("ollama: no backends configured");
    }

    let lastErr = null;
    for (const [i, backend] of backends.entries()) {
      // Skip the backend that just failed the fast path (its probe may
      // still pass — /api/tags doesn't care if /api/chat is broken — and
      // we don't want a second chat-call attempt on the same cycle).
      if (justFailedName && backend.name === justFailedName) continue;
      const reachable = await probeBackend(backend);
      if (!reachable) continue;
      try {
        const result = await callChatOnce(backend, userPrompt, systemPrompt);
        cachedBackend = backend;
        cacheUntil = Date.now() + (i === 0 ? probeTtlMs : fallbackTtlMs);
        noteActive(backend);
        return result;
      } catch (err) {
        lastErr = err;
        // Probe said yes but call failed — try the next backend.
      }
    }

    // Nothing reachable. Set the backoff so the next call doesn't probe
    // every backend again immediately.
    quietUntil = Date.now() + failTtlMs;
    noteAllUnreachable();
    throw lastErr || new Error("ollama: no backend reachable");
  }

  // host is intentionally NOT exposed here — it could contain operator-
  // configured URLs we don't want forwarded blindly to clients. /health
  // and other consumers only need name + model to render status.
  callOllama.getActiveBackend = () =>
    cachedBackend
      ? { name: cachedBackend.name, model: cachedBackend.model }
      : null;

  /**
   * Force the next call to re-probe. Called on config changes (e.g.,
   * the operator rotates the peer-bridge token via Settings) so the
   * cached active backend doesn't keep using the stale token for up
   * to its TTL window.
   */
  callOllama.invalidate = () => {
    cachedBackend = null;
    cacheUntil = 0;
    quietUntil = 0;
  };

  return callOllama;
}
