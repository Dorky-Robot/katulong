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

import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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

/**
 * Build (but don't start) an http.Server for a bridge. Pass the resolved
 * manifest+config so the caller controls validation and persistence.
 */
export function createBridgeServer({ target, token }) {
  const targetUrl = new URL(target);
  const targetIsHttps = targetUrl.protocol === "https:";
  const proxyRequest = targetIsHttps ? httpsRequest : httpRequest;

  return createServer((req, res) => {
    if (!bearerMatches(req.headers.authorization, token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Strip the bridge's auth before forwarding — the wrapped service does
    // not expect it and we don't want our token leaking into upstream logs.
    const upstreamHeaders = { ...req.headers };
    delete upstreamHeaders.authorization;
    delete upstreamHeaders.host;

    const upstreamReq = proxyRequest(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetIsHttps ? 443 : 80),
        method: req.method,
        path: req.url,
        headers: upstreamHeaders,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_unreachable", detail: err.message }));
    });

    req.pipe(upstreamReq);
  });
}

export function startBridgeServer({ port, bind, target, token }) {
  const server = createBridgeServer({ target, token });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
