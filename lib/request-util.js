/**
 * HTTP request/response utility functions.
 *
 * Extracted from server.js so they can be tested independently
 * and reused across modules.
 */

const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB limit for request bodies

/**
 * Read the full request body as a string with size limiting.
 *
 * @param {import('http').IncomingMessage} req
 * @param {number} maxSize - Maximum body size in bytes (default 1MB)
 * @returns {Promise<string>}
 */
export function readBody(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Read and parse JSON from the request body.
 *
 * @param {import('http').IncomingMessage} req
 * @param {number} maxSize - Maximum body size in bytes (default 1MB)
 * @returns {Promise<any>}
 */
export async function parseJSON(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  const body = await readBody(req, maxSize);
  return JSON.parse(body);
}

/**
 * Send a JSON response.
 *
 * @param {import('http').ServerResponse} res
 * @param {number} status - HTTP status code
 * @param {any} data - Data to serialize as JSON
 */
export function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Set standard security headers on a response.
 *
 * @param {import('http').ServerResponse} res
 */
export function setSecurityHeaders(res) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}
