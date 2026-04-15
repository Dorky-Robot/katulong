/**
 * Shared HTTP client for CLI commands.
 *
 * Talks to the running Katulong server on localhost.
 * Localhost requests bypass auth and CSRF automatically.
 */

import { isServerRunning, getServerBaseUrl } from "./process-manager.js";

/**
 * Re-exported so command files can import URL resolution from api-client
 * without reaching into process-manager directly. Each call re-reads
 * `~/.katulong/server.json`, so resolution stays lazy and current — the old
 * module-load `BASE` constant was replaced because it paid a synchronous TCP
 * probe on every CLI invocation (including `katulong --help`) and couldn't
 * pick up a mid-command server restart on a different port. See
 * `getServerBaseUrl` in process-manager.js for the full rationale.
 */
export { getServerBaseUrl as getBase } from "./process-manager.js";

/**
 * Ensure the server is running. Exits with a message if not.
 *
 * Uses `isServerRunning()` (which itself prefers server.json) so the check
 * agrees with the URL we'll actually hit. We no longer special-case
 * `KATULONG_PORT` here — that env var was previously used as a "trust me, the
 * server is up" hint, but in long-lived shells it can outlive the server it
 * referred to and produce confusing "server is not running" errors when the
 * real server is alive on a different port.
 */
export function ensureRunning() {
  const status = isServerRunning();
  if (!status.running) {
    console.error("Server is not running. Start with: katulong start");
    process.exit(1);
  }
}

/**
 * Make an HTTP request to the local server.
 * @param {string} method - HTTP method
 * @param {string} path - URL path (e.g. "/api/tokens")
 * @param {object} [body] - JSON body for POST/PUT/PATCH
 * @returns {Promise<{status: number, data: any}>}
 */
async function request(method, path, body) {
  const opts = {
    method,
    headers: {},
  };

  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${getServerBaseUrl()}${path}`, opts);
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED" || err.code === "ECONNREFUSED") {
      console.error("Server is not running. Start with: katulong start");
      process.exit(1);
    }
    throw err;
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const msg = data?.error || `HTTP ${response.status}`;
    throw new Error(msg);
  }

  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  del: (path) => request("DELETE", path),
};

/**
 * Resolve a friendly session name to its surrogate id.
 *
 * The error message shape "Session not found: <name>" is grepped by the
 * crew output/wait 404 branches — don't change it without updating them.
 *
 * @param {string} name - friendly session name
 * @returns {Promise<string>} the session's immutable id
 * @throws {Error} if no session with that name exists
 */
export async function resolveSessionId(name) {
  const sessions = await api.get("/sessions");
  if (!Array.isArray(sessions)) throw new Error("Unexpected response from server.");
  const match = sessions.find((s) => s.name === name);
  if (!match) throw new Error(`Session not found: ${name}`);
  return match.id;
}
