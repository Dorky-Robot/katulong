/**
 * Shared HTTP client for CLI commands.
 *
 * Talks to the running Katulong server on localhost.
 * Localhost requests bypass auth and CSRF automatically.
 */

import { isServerRunning } from "./process-manager.js";
import envConfig from "../env-config.js";

// KATULONG_PORT is set by the server in tmux sessions; PORT is the general config
const BASE = `http://localhost:${process.env.KATULONG_PORT || envConfig.port}`;

/**
 * Ensure the server is running. Exits with a message if not.
 * When KATULONG_PORT is set (inside a katulong tmux session), skip the
 * PID file check — the server may be on a non-default port. The request
 * itself will fail with ECONNREFUSED if the server is truly down.
 */
export function ensureRunning() {
  if (process.env.KATULONG_PORT) return; // trust the env — request will fail if wrong
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
