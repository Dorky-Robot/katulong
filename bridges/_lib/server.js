/**
 * Shared bridge HTTP server.
 *
 * A bridge is a credential-holding reverse proxy in front of a local-only
 * HTTP service that katulong wants to talk to (e.g., Ollama). Each bridge
 * is a separate process; this module is the runtime they all share.
 *
 * The bridge is intentionally opaque to the wrapped service's API: method,
 * path, headers (minus auth), and body all forward verbatim. New endpoints
 * on the wrapped service get picked up automatically.
 *
 * One transport-level carve-out: when the upstream returns
 * `Content-Type: text/event-stream`, the bridge injects keepalive SSE
 * comments during upstream silence and forces no-cache headers, so long
 * generations survive intermediate-proxy idle timeouts. The keepalive
 * frame (`: keepalive\n\n`) is spec-defined as ignored by SSE clients,
 * so the wrapped service's wire contract is preserved.
 *
 * Auth is bearer-token only in v1. The wire shape (`Authorization: Bearer
 * <token>`) is the same shape the eventual katulong-app/1 runtime call
 * will use, so when the protocol's host implementation lands, this server
 * gains the four well-known endpoints (manifest, install, intent-pull,
 * health) as a purely additive change. Nothing here gets thrown away.
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// 512 MB cap on incoming bodies. Generous enough for image-paste payloads
// and large LLM prompts; bounded enough that a malicious holder of a valid
// token cannot exhaust host disk/memory by sending an unbounded stream.
const MAX_BODY_BYTES = 512 * 1024 * 1024;

// SSE keepalive cadence. When upstream goes silent on a `text/event-stream`
// response (e.g. an LLM is in its reasoning phase before any visible
// tokens), inject `: keepalive\n\n` SSE comments so intermediate proxies
// (Cloudflare, cloudflared, nginx) don't trip their "idle response"
// timeouts and tear the connection down. 15s is comfortably inside
// Cloudflare's ~100s edge timeout.
const SSE_KEEPALIVE_MS = 15_000;
// Heuristic: treat any response whose content-type starts with this as SSE.
const SSE_CT_PREFIX = "text/event-stream";

// Headers that must NOT propagate end-to-end, per RFC 7230 §6.1 (hop-by-hop)
// plus forwarding headers a client could lie about to influence upstream
// routing/trust decisions. `authorization` and `host` are stripped separately
// (one is the bridge's own token; the other is recomputed by the http client).
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "x-original-url",
  "forwarded",
]);

/**
 * Constant-time-ish bearer comparison. Avoids early-exit timing leakage
 * on the token bytes; fine for a paste-from-CLI token where the threat
 * model is "someone fishing for the token over local network."
 */
export function bearerMatches(headerValue, expected) {
  if (typeof headerValue !== "string") return false;
  if (!headerValue.startsWith("Bearer ")) return false;
  const presented = headerValue.slice(7);
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function sanitizedUpstreamHeaders(rawHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    const lk = k.toLowerCase();
    if (lk === "authorization" || lk === "host") continue;
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build (but don't start) an http.Server for a bridge. Pass the resolved
 * manifest+config so the caller controls validation and persistence.
 *
 * `logger` is optional and is called with structured events:
 *   {event: "auth_failure", remoteAddress, reason}
 *   {event: "upstream_error", code}
 * Default is a console.warn writer; tests can override with a no-op or
 * collector. The token itself is never passed to the logger.
 */
export function createBridgeServer({ target, token, logger = defaultLogger, keepaliveMs = SSE_KEEPALIVE_MS }) {
  // Defensive clamp: any non-finite or sub-50ms value would either crash
  // setInterval (NaN → 1ms CPU burn) or pin the loop with sub-millisecond
  // ticks. The lower floor matches `Math.max(50, …)` below so callers can
  // still tune low for tests without falling off the cliff.
  if (!Number.isFinite(keepaliveMs) || keepaliveMs < 50) {
    keepaliveMs = SSE_KEEPALIVE_MS;
  }
  const targetUrl = new URL(target);
  const targetIsHttps = targetUrl.protocol === "https:";
  const proxyRequest = targetIsHttps ? httpsRequest : httpRequest;

  return createServer((req, res) => {
    if (!bearerMatches(req.headers.authorization, token)) {
      logger({
        event: "auth_failure",
        remoteAddress: req.socket?.remoteAddress,
        reason: req.headers.authorization ? "wrong_token" : "missing_header",
      });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const upstreamReq = proxyRequest(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetIsHttps ? 443 : 80),
        method: req.method,
        path: req.url,
        headers: sanitizedUpstreamHeaders(req.headers),
      },
      (upstreamRes) => {
        const isSse = (upstreamRes.headers["content-type"] || "").startsWith(SSE_CT_PREFIX);
        forwardResponse({ upstreamRes, upstreamReq, res, isSse, keepaliveMs, logger });
      },
    );

    upstreamReq.on("error", (err) => {
      logger({ event: "upstream_error", code: err.code || err.name });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // Don't leak upstream URL or system call details; the caller already
      // knows where the bridge is configured to forward, and an attacker
      // who got past the bearer check shouldn't get free network mapping.
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_unreachable" }));
    });

    // Manual forward (instead of req.pipe) so we can enforce a body-size
    // cap in the same data listener that does the writing — using two
    // listeners would put req into flowing mode prematurely and the pipe
    // would silently miss data.
    let bytesIn = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      bytesIn += chunk.length;
      if (bytesIn > MAX_BODY_BYTES) {
        aborted = true;
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large", limit: MAX_BODY_BYTES }));
        }
        upstreamReq.destroy();
        return;
      }
      upstreamReq.write(chunk);
    });
    req.on("end", () => { if (!aborted) upstreamReq.end(); });
    req.on("error", () => upstreamReq.destroy());
  });
}


/**
 * Forward an upstream response to the client. For SSE responses, inject
 * keepalive comments during upstream silence so intermediate proxies
 * don't time out. For everything else, this is a verbatim pipe.
 *
 * On client disconnect (the very scenario keepalive enables — long-lived
 * SSE responses), we explicitly destroy `upstreamReq` so the upstream
 * stops generating bytes for a connection that has nowhere to go. We
 * also gate every `res.write` on `res.destroyed || res.writableEnded`
 * so a stale data event between client-close and upstream-teardown
 * cannot trigger an unhandled `ERR_STREAM_DESTROYED`. (The non-SSE
 * `pipe(res)` path gets these properties from Node's stream plumbing
 * for free; the manual forward here has to declare them.)
 */
function forwardResponse({ upstreamRes, upstreamReq, res, isSse, keepaliveMs, logger }) {
  // Single source of truth for upstream errors on either branch. Logging
  // and tearing down `res` is consistent across SSE/non-SSE.
  upstreamRes.on("error", (err) => {
    logger({ event: "upstream_error", code: err.code || err.name });
    if (!res.destroyed) res.destroy(err);
  });

  if (!isSse) {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
    return;
  }

  // Belt-and-suspenders: hint to anything along the path that it must
  // not buffer this response. Cloudflare honors `text/event-stream` on
  // its own; nginx-shaped intermediaries also key off X-Accel-Buffering.
  // SSE is inherently a "live, ephemeral, do not cache" payload, so we
  // unconditionally force `no-cache, no-store` rather than respecting an
  // upstream-set Cache-Control that would let intermediaries try to
  // cache the stream.
  // Strip `transfer-encoding` and `content-length` so Node manages the
  // framing for the bytes we write (otherwise res.write payloads bypass
  // the chunked encoder and the client sees a corrupt stream).
  const headers = { ...upstreamRes.headers };
  delete headers["transfer-encoding"];
  delete headers["content-length"];
  headers["x-accel-buffering"] = "no";
  headers["cache-control"] = "no-cache, no-store";
  res.writeHead(upstreamRes.statusCode || 502, headers);

  // Single guard for every write attempt — on the keepalive tick AND on
  // the upstream data handler. Returns true if the write proceeded.
  const safeWrite = (bytes) => {
    if (res.writableEnded || res.destroyed) return false;
    res.write(bytes);
    return true;
  };

  let lastByteAt = Date.now();
  let ended = false;
  // Tick at ~1/3 of the keepalive interval so the worst-case delay
  // between idle threshold crossing and an injected comment is bounded
  // by one tick.
  const tick = setInterval(() => {
    if (ended) return;
    if (Date.now() - lastByteAt < keepaliveMs) return;
    if (!safeWrite(": keepalive\n\n")) {
      clearInterval(tick);
      return;
    }
    lastByteAt = Date.now();
  }, Math.max(50, Math.floor(keepaliveMs / 3)));

  // Single point that ends the per-request bookkeeping. Idempotent — the
  // various lifecycle events all funnel through here. `destroyUpstream`
  // is the key fix: when the client disconnects, we must stop pulling
  // bytes from upstream, otherwise the data handler below keeps trying
  // to write to a dead `res` (HIGH severity bug pre-fix).
  const finish = ({ destroyUpstream }) => {
    if (ended) return;
    ended = true;
    clearInterval(tick);
    if (destroyUpstream && upstreamReq && !upstreamReq.destroyed) {
      upstreamReq.destroy();
    }
  };

  upstreamRes.on("data", (chunk) => {
    if (ended) return;
    lastByteAt = Date.now();
    if (!safeWrite(chunk)) {
      // Client gone — stop pulling bytes from upstream.
      finish({ destroyUpstream: true });
    }
  });
  upstreamRes.on("end", () => {
    finish({ destroyUpstream: false });
    if (!res.writableEnded) res.end();
  });
  // Note: `upstreamRes.on("error")` is registered above (covers SSE +
  // non-SSE). It calls `res.destroy(err)`, which fires `res.on("close")`
  // below, which runs `finish({ destroyUpstream: true })`.
  res.on("close", () => {
    finish({ destroyUpstream: true });
  });
}

function defaultLogger(event) {
  // Single-line structured log so it shows up readably in launchd-stderr.log.
  // The caller can swap this for nothing in tests.
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

export function startBridgeServer({ port, bind, target, token, logger, keepaliveMs }) {
  const server = createBridgeServer({ target, token, logger, keepaliveMs });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
