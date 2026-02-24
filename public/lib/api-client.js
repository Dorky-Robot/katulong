/**
 * Centralized API client.
 *
 * Wraps fetch() with automatic CSRF token injection for state-mutating
 * requests and consistent JSON error handling.
 */

import { getCsrfToken } from "/lib/csrf.js";

function csrfHeaders() {
  const token = getCsrfToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-CSRF-Token"] = token;
  return headers;
}

async function request(method, url, data) {
  const opts = { method, headers: csrfHeaders() };
  if (data !== undefined) opts.body = JSON.stringify(data);
  const res = await fetch(url, opts);
  if (!res.ok) {
    let message = `${method} ${url} failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch { /* non-JSON error response */ }
    throw new Error(message);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const api = {
  get: (url) => fetch(url).then(r => r.ok ? r.json() : Promise.reject(new Error(`GET ${url} failed (${r.status})`))),
  post: (url, data) => request("POST", url, data),
  put: (url, data) => request("PUT", url, data),
  patch: (url, data) => request("PATCH", url, data),
  delete: (url, data) => request("DELETE", url, data),
};
