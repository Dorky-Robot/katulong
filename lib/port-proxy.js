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
 * Build an inline script that intercepts client-side navigations
 * (location.href = '/path', link clicks, fetch, etc.) and rewrites
 * absolute paths to stay within the proxy prefix.
 *
 * Uses the Navigation API (Chrome 102+) when available to catch
 * location.href assignments, which can't be monkey-patched.
 *
 * @param {string} prefix - e.g. "/_proxy/7070/"
 * @returns {string}
 */
function navigationInterceptScript(prefix) {
  return `<script>(function(){` +
    `var P=${JSON.stringify(prefix)};` +
    // needsRewrite: same-origin absolute path not already under /_proxy/
    `function n(u){try{var o=new URL(u,location.href);` +
    `return o.origin===location.origin&&!o.pathname.startsWith("/_proxy/")}catch(e){return false}}` +
    // rewrite: prepend prefix to the path
    `function r(u){try{var o=new URL(u,location.href);` +
    `if(o.origin===location.origin&&!o.pathname.startsWith("/_proxy/"))` +
    `return P+o.pathname.slice(1)+o.search+o.hash}catch(e){}return u}` +
    // Navigation API — catches location.href=, location=, location.assign(), etc.
    `if(window.navigation){navigation.addEventListener("navigate",function(e){` +
    `if(!e.canIntercept||e.hashChange)return;` +
    `var d=new URL(e.destination.url);` +
    `if(d.origin!==location.origin||d.pathname.startsWith("/_proxy/"))return;` +
    `e.preventDefault();` +
    `location.replace(P+d.pathname.slice(1)+d.search+d.hash)` +
    `})}` +
    // Fallback: monkey-patch location.assign / location.replace
    `var la=Location.prototype.assign,lr=Location.prototype.replace;` +
    `Location.prototype.assign=function(u){return la.call(this,r(u))};` +
    `Location.prototype.replace=function(u){return lr.call(this,r(u))};` +
    // Intercept link clicks
    `document.addEventListener("click",function(e){` +
    `var a=e.target.closest&&e.target.closest("a[href]");` +
    `if(a&&n(a.href)){e.preventDefault();location.href=r(a.href)}` +
    `},true);` +
    // Intercept form submissions
    `document.addEventListener("submit",function(e){` +
    `var f=e.target;if(f.action&&n(f.action))f.action=r(f.action)` +
    `},true);` +
    // Intercept fetch
    `var of=window.fetch;` +
    `window.fetch=function(i,o){` +
    `if(typeof i==="string")i=r(i);` +
    `else if(i instanceof Request&&n(i.url))i=new Request(r(i.url),i);` +
    `return of.call(this,i,o)};` +
    // Intercept XMLHttpRequest.open
    `var xo=XMLHttpRequest.prototype.open;` +
    `XMLHttpRequest.prototype.open=function(m,u){` +
    `arguments[1]=r(u);return xo.apply(this,arguments)};` +
    `})()</script>`;
}

/**
 * Rewrite HTML to make relative URLs work under the proxy prefix.
 *
 * Injects a <base> tag, a navigation-interception script, and rewrites
 * src="/...", href="/...", action="/..." attributes.
 * Skips protocol-relative ("//") and absolute ("http") URLs.
 *
 * @param {string} html
 * @param {string} prefix - e.g. "/_proxy/7070/"
 * @returns {string}
 */
export function rewriteProxiedHtml(html, prefix) {
  // Rewrite root-relative attribute values FIRST (before injecting tags)
  // so the base tag's own href doesn't get double-rewritten.
  // Skip protocol-relative (//), absolute (http:// https://), and anchor-only (#)
  html = html.replace(
    /(\b(?:src|href|action)\s*=\s*["'])\/(?!\/)(.*?)(["'])/gi,
    (match, pre, path, post) => {
      if (/^https?:\/\//i.test("/" + path)) return match;
      return `${pre}${prefix}${path}${post}`;
    }
  );

  // Inject <base> tag + navigation interception script
  const injection = `<base href="${prefix}">${navigationInterceptScript(prefix)}`;
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1${injection}`);
  } else {
    html = injection + html;
  }

  return html;
}

/**
 * Rewrite a Location header so redirects stay inside the proxy prefix.
 * Handles root-relative (/path) and absolute (http://127.0.0.1:<port>/path) URLs.
 *
 * @param {string} loc - Original Location header value
 * @param {number} port - Target port being proxied
 * @param {string} prefix - e.g. "/_proxy/7070/"
 * @returns {string}
 */
export function rewriteLocation(loc, port, prefix) {
  // Root-relative: /login → /_proxy/7070/login
  if (loc.startsWith("/")) {
    return prefix + loc.slice(1);
  }

  // Absolute URL pointing at the target: http(s)://127.0.0.1:7070/path → /_proxy/7070/path
  try {
    const url = new URL(loc);
    if (
      url.hostname === "127.0.0.1" &&
      String(url.port || (url.protocol === "https:" ? 443 : 80)) === String(port)
    ) {
      return prefix + url.pathname.slice(1) + url.search + url.hash;
    }
  } catch {
    // Not a valid URL — return as-is
  }

  return loc;
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
        proxyRes.headers.location = rewriteLocation(
          proxyRes.headers.location, port, prefix
        );
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

      // Guard against upstream TCP reset mid-response
      proxyRes.on("error", (err) => {
        log.warn("Port proxy upstream error", { port, path, error: err.message });
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
        }
        res.destroy();
      });

      const contentType = proxyRes.headers["content-type"] || "";
      const isHtml = contentType.includes("text/html");

      if (isHtml) {
        // Buffer HTML so we can rewrite it. Cap at 50MB — beyond that,
        // give up on rewriting and stream the body unchanged. Without
        // this cap an authenticated user pointing the proxy at an
        // upstream that returns multi-GB HTML would exhaust the heap
        // and crash the server (DoS for everyone connected).
        const HTML_REWRITE_CAP = 50 * 1024 * 1024;
        const chunks = [];
        let totalBytes = 0;
        let bypassRewrite = false;
        proxyRes.on("data", (chunk) => {
          if (bypassRewrite) {
            res.write(chunk);
            return;
          }
          totalBytes += chunk.length;
          if (totalBytes > HTML_REWRITE_CAP) {
            bypassRewrite = true;
            log.warn("Port proxy HTML rewrite capped — streaming raw", {
              port, path, capBytes: HTML_REWRITE_CAP,
            });
            // Flush what we've buffered so far without rewriting, then
            // pipe the rest verbatim.
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            for (const c of chunks) res.write(c);
            chunks.length = 0;
            res.write(chunk);
            return;
          }
          chunks.push(chunk);
        });
        proxyRes.on("end", () => {
          if (bypassRewrite) {
            res.end();
            return;
          }
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
  const { auth, PORT, configManager } = ctx;

  function handler(req, res, param) {
    if (configManager && configManager.getPortProxyEnabled() === false) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Port proxy is disabled");
      return;
    }
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
