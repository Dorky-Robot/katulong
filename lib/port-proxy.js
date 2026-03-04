/**
 * Localhost Port Proxy
 *
 * Reverse-proxies HTTP and WebSocket requests from /_proxy/<port>/...
 * to 127.0.0.1:<port>/... on the host machine. Piggybacks on Katulong's
 * existing WebAuthn auth so only passkey-authenticated users can reach
 * proxied services.
 *
 * Security notes:
 *   - Only proxies to 127.0.0.1 (no SSRF risk — authed users have shell)
 *   - katulong_session cookie stripped from forwarded requests
 *   - Host header set to 127.0.0.1:<port>, not forwarded from client
 *   - X-Frame-Options / frame-ancestors stripped so iframe embedding works
 *   - Accept-Encoding removed to avoid compressed responses that need rewriting
 */

import http from "node:http";
import { log } from "./log.js";

/**
 * Parse and validate a port string.
 * Returns the numeric port or null if invalid.
 *
 * @param {string} portStr
 * @param {number} ownPort - Katulong's own port (disallowed)
 * @returns {number|null}
 */
export function validatePort(portStr, ownPort) {
  const port = parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  if (String(port) !== portStr) return null; // reject "07070", "3.14", etc.
  if (port === ownPort) return null;
  return port;
}

/**
 * Remove katulong_session from a Cookie header value.
 *
 * @param {string} cookieHeader
 * @returns {string}
 */
export function stripKatulongCookies(cookieHeader) {
  if (!cookieHeader) return "";
  return cookieHeader
    .split(";")
    .map(c => c.trim())
    .filter(c => !c.startsWith("katulong_session="))
    .join("; ");
}

/**
 * Rewrite HTML to make relative URLs work under the proxy prefix.
 *
 * Injects a <base> tag and rewrites src="/...", href="/...", action="/..."
 * attributes. Skips protocol-relative ("//") and absolute ("http") URLs.
 *
 * @param {string} html
 * @param {string} prefix - e.g. "/_proxy/7070/"
 * @returns {string}
 */
export function rewriteProxiedHtml(html, prefix) {
  // Rewrite root-relative attribute values FIRST (before injecting <base>)
  // so the base tag's own href doesn't get double-rewritten.
  // Skip protocol-relative (//), absolute (http:// https://), and anchor-only (#)
  html = html.replace(
    /(\b(?:src|href|action)\s*=\s*["'])\/(?!\/)(.*?)(["'])/gi,
    (match, pre, path, post) => {
      if (/^https?:\/\//i.test("/" + path)) return match;
      return `${pre}${prefix}${path}${post}`;
    }
  );

  // Inject <base> tag right after <head> (or at the start if no <head>)
  const baseTag = `<base href="${prefix}">`;
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1${baseTag}`);
  } else {
    html = baseTag + html;
  }

  return html;
}

/**
 * Parse "/_proxy/<port>/rest/of/path" into { port, path }.
 * Returns null if the URL doesn't match the proxy prefix.
 */
function parseProxyUrl(pathname) {
  const match = pathname.match(/^\/_proxy\/(\d+)(\/.*)?$/);
  if (!match) return null;
  return {
    portStr: match[1],
    path: match[2] || "/",
  };
}

/**
 * Proxy an HTTP request to localhost:<port>.
 */
export function proxyHttpRequest(req, res, port, path) {
  const prefix = `/_proxy/${port}/`;

  // Build headers to forward
  const fwdHeaders = { ...req.headers };
  delete fwdHeaders["accept-encoding"]; // avoid compressed responses we'd need to decompress
  fwdHeaders.host = `127.0.0.1:${port}`;
  const stripped = stripKatulongCookies(fwdHeaders.cookie);
  if (stripped) {
    fwdHeaders.cookie = stripped;
  } else {
    delete fwdHeaders.cookie;
  }

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path,
      method: req.method,
      headers: fwdHeaders,
    },
    (proxyRes) => {
      // Rewrite Location header for redirects
      if (proxyRes.headers.location) {
        const loc = proxyRes.headers.location;
        if (loc.startsWith("/")) {
          proxyRes.headers.location = prefix + loc.slice(1);
        }
      }

      // Rewrite Set-Cookie Path attributes
      if (proxyRes.headers["set-cookie"]) {
        proxyRes.headers["set-cookie"] = (
          Array.isArray(proxyRes.headers["set-cookie"])
            ? proxyRes.headers["set-cookie"]
            : [proxyRes.headers["set-cookie"]]
        ).map(c =>
          c.replace(/;\s*path\s*=\s*\//gi, `; Path=${prefix}`)
        );
      }

      // Strip framing restrictions so the iframe works
      delete proxyRes.headers["x-frame-options"];
      const csp = proxyRes.headers["content-security-policy"];
      if (csp) {
        proxyRes.headers["content-security-policy"] = csp.replace(
          /frame-ancestors\s+[^;]*(;|$)/gi,
          ""
        );
      }

      const contentType = proxyRes.headers["content-type"] || "";
      const isHtml = contentType.includes("text/html");

      if (isHtml) {
        // Buffer HTML so we can rewrite it
        const chunks = [];
        proxyRes.on("data", (chunk) => chunks.push(chunk));
        proxyRes.on("end", () => {
          let body = Buffer.concat(chunks).toString("utf-8");
          body = rewriteProxiedHtml(body, prefix);
          // Update content-length after rewrite
          delete proxyRes.headers["content-length"];
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(body);
        });
      } else {
        // Stream non-HTML responses directly
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    }
  );

  proxyReq.on("error", (err) => {
    log.warn("Port proxy request failed", { port, path, error: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Could not connect to localhost:${port}`);
    }
  });

  // Pipe the incoming request body to the proxy
  req.pipe(proxyReq);
}

/**
 * Proxy a WebSocket upgrade to localhost:<port>.
 * Called after auth has already been verified in handleUpgrade.
 */
export function proxyWebSocket(req, socket, head, pathname) {
  const parsed = parseProxyUrl(pathname);
  if (!parsed) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const port = parseInt(parsed.portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const fwdHeaders = { ...req.headers };
  fwdHeaders.host = `127.0.0.1:${port}`;
  const stripped = stripKatulongCookies(fwdHeaders.cookie);
  if (stripped) {
    fwdHeaders.cookie = stripped;
  } else {
    delete fwdHeaders.cookie;
  }

  const proxyReq = http.request({
    hostname: "127.0.0.1",
    port,
    path: parsed.path,
    method: "GET",
    headers: fwdHeaders,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    // Forward the 101 Switching Protocols response
    let response = `HTTP/1.1 101 Switching Protocols\r\n`;
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      response += `${key}: ${value}\r\n`;
    }
    response += "\r\n";
    socket.write(response);

    // Bidirectional pipe
    if (proxyHead.length > 0) proxySocket.unshift(proxyHead);
    if (head.length > 0) socket.unshift(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    proxySocket.on("close", () => socket.destroy());
    socket.on("close", () => proxySocket.destroy());
  });

  proxyReq.on("error", (err) => {
    log.warn("Port proxy WS connect failed", { port, error: err.message });
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
  });

  proxyReq.end();
}

/**
 * Create route definitions for the port proxy.
 * Each route is auth-wrapped for defense-in-depth.
 *
 * @param {object} ctx - Route context (must include auth, PORT)
 * @returns {Array} Route definition objects
 */
export function createPortProxyRoutes(ctx) {
  const { auth, PORT } = ctx;

  function handler(req, res, param) {
    // param is everything after "/_proxy/" (e.g. "7070/some/path")
    const slashIdx = param.indexOf("/");
    const portStr = slashIdx === -1 ? param : param.slice(0, slashIdx);
    const path = slashIdx === -1 ? "/" : param.slice(slashIdx);

    const port = validatePort(portStr, PORT);
    if (port === null) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid port");
      return;
    }

    proxyHttpRequest(req, res, port, path);
  }

  const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
  return methods.map((method) => ({
    method,
    prefix: "/_proxy/",
    handler: auth(handler),
  }));
}
