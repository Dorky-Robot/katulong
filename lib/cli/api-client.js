/**
 * Shared HTTP client for CLI commands.
 *
 * Talks to the running Katulong server on localhost.
 * Localhost requests bypass auth and CSRF automatically.
 */

import { isServerRunning, getServerBaseUrl } from "./process-manager.js";

/**
 * Base URL for the running katulong server.
 *
 * Resolved at module load from the authoritative `~/.katulong/server.json`
 * (written by the live server) when available. Falls back to `KATULONG_PORT`
 * env / config defaults for the boot-without-server case.
 *
 * Why not just trust `KATULONG_PORT`? It's set into tmux's global env at
 * server start, so panes that pre-date the most recent server restart still
 * carry the *previous* port. Reading server.json sidesteps that staleness.
 */
export const BASE = getServerBaseUrl();

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
    response = await fetch(`${BASE}${path}`, opts);
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
