/**
 * Access Method Detection
 *
 * Determines how the user is accessing Katulong:
 * - "localhost" - Direct access from same machine (127.0.0.1, localhost)
 * - "lan" - Local network access (192.168.x.x, 10.x.x.x, katulong.local)
 * - "internet" - Remote access via reverse proxy (ngrok, Cloudflare Tunnel, etc.)
 *
 * This classification is used to determine:
 * - Whether to enforce HTTPS
 * - Which authentication flows to allow
 * - Which UI to show on login page
 */

/**
 * Detect if request is coming from localhost (same machine).
 *
 * SECURITY CRITICAL: This function determines whether to bypass authentication.
 * It checks BOTH socket address AND Host/Origin headers to prevent proxy bypass.
 *
 * Example: ngrok forwards requests from 0.0.0.0:4040 to 127.0.0.1:3001
 * - req.socket.remoteAddress = "127.0.0.1" (loopback)
 * - req.headers.host = "felix-katulong.ngrok.app" (not localhost!)
 *
 * Without checking headers, ngrok traffic would be treated as localhost and bypass auth.
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @returns {boolean} True if request is from localhost
 */
export function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || "";

  // Check socket address - must be loopback
  const isLoopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  if (!isLoopback) return false;

  // CRITICAL SECURITY: Even if socket is loopback, check Host/Origin headers
  // to detect reverse proxies (ngrok, Cloudflare Tunnel, etc.)
  // If Host/Origin indicates external domain, this is PROXIED traffic = NOT local
  const host = (req.headers.host || "").toLowerCase();
  const origin = (req.headers.origin || "").toLowerCase();

  // Check if Host header indicates localhost
  const hostIsLocal = host.startsWith("localhost:") ||
                      host === "localhost" ||
                      host.startsWith("127.0.0.1:") ||
                      host === "127.0.0.1" ||
                      host.startsWith("[::1]:") ||
                      host === "[::1]";

  // Check if Origin header indicates localhost (if present)
  const originIsLocal = !origin ||
                        origin.includes("://localhost") ||
                        origin.includes("://127.0.0.1") ||
                        origin.includes("://[::1]");

  // Only treat as local if BOTH socket AND headers indicate localhost
  return hostIsLocal && originIsLocal;
}

/**
 * Detect if request is coming from local area network.
 *
 * LAN access is characterized by:
 * - Private IP addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
 * - .local mDNS domains (katulong.local)
 * - Link-local addresses (169.254.x.x)
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @returns {boolean} True if request is from LAN
 */
export function isLanRequest(req) {
  const host = (req.headers.host || "").toLowerCase().split(":")[0];

  // Check for .local mDNS domains
  if (host.endsWith(".local")) return true;

  // Check for private IP addresses (RFC 1918)
  if (/^10\./.test(host)) return true;                          // 10.0.0.0/8
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;    // 172.16.0.0/12
  if (/^192\.168\./.test(host)) return true;                    // 192.168.0.0/16
  if (/^169\.254\./.test(host)) return true;                    // 169.254.0.0/16 (link-local)

  return false;
}

/**
 * Get the access method for this request.
 *
 * Returns one of:
 * - "localhost" - Same machine, auto-authenticated
 * - "lan" - Local network, requires passkey
 * - "internet" - Remote access, requires passkey + setup token
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @returns {"localhost" | "lan" | "internet"} Access method
 */
export function getAccessMethod(req) {
  if (isLocalRequest(req)) return "localhost";
  if (isLanRequest(req)) return "lan";
  return "internet";
}

/**
 * Get a human-readable description of the access method.
 * Useful for logging and debugging.
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @returns {string} Description like "localhost (127.0.0.1)" or "internet (ngrok.app)"
 */
export function getAccessDescription(req) {
  const method = getAccessMethod(req);
  const host = (req.headers.host || "unknown").split(":")[0];
  const addr = req.socket.remoteAddress || "unknown";

  switch (method) {
    case "localhost":
      return `localhost (${addr})`;
    case "lan":
      return `lan (${host})`;
    case "internet":
      return `internet (${host})`;
    default:
      return `unknown (${host})`;
  }
}
