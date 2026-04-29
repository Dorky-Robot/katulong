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
        // Mid-stream upstream errors: forward as a destroy on the client
        // side rather than letting an unhandled `error` event crash the
        // bridge process.
        upstreamRes.on("error", (err) => {
          logger({ event: "upstream_error", code: err.code || err.name });
          res.destroy(err);
        });
        const isSse = (upstreamRes.headers["content-type"] || "").startsWith(SSE_CT_PREFIX);
        forwardResponse({ upstreamRes, res, isSse, keepaliveMs });
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
 */
function forwardResponse({ upstreamRes, res, isSse, keepaliveMs }) {
  if (!isSse) {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
    return;
  }

  // Belt-and-suspenders: hint to anything along the path that it must
  // not buffer this response. Cloudflare honors `text/event-stream` on
  // its own; nginx-shaped intermediaries also key off X-Accel-Buffering.
  // Strip `transfer-encoding` and `content-length` so Node manages the
  // framing for the bytes we write (otherwise res.write payloads bypass
  // the chunked encoder and the client sees a corrupt stream).
  const headers = { ...upstreamRes.headers };
  delete headers["transfer-encoding"];
  delete headers["content-length"];
  headers["x-accel-buffering"] = "no";
  headers["cache-control"] = headers["cache-control"] || "no-cache";
  res.writeHead(upstreamRes.statusCode || 502, headers);

  let lastByteAt = Date.now();
  let ended = false;
  const tick = setInterval(() => {
    if (ended) return;
    if (Date.now() - lastByteAt < keepaliveMs) return;
    if (res.writableEnded || res.destroyed) {
      clearInterval(tick);
      return;
    }
    res.write(": keepalive\n\n");
    lastByteAt = Date.now();
  }, Math.max(50, Math.floor(keepaliveMs / 3)));

  upstreamRes.on("data", (chunk) => {
    lastByteAt = Date.now();
    res.write(chunk);
  });
  upstreamRes.on("end", () => {
    ended = true;
    clearInterval(tick);
    res.end();
  });
  upstreamRes.on("error", (err) => {
    ended = true;
    clearInterval(tick);
    if (!res.destroyed) res.destroy(err);
  });
  res.on("close", () => {
    if (!ended) {
      ended = true;
      clearInterval(tick);
    }
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
