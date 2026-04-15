/**
 * Centralized API client.
 *
 * Wraps fetch() with automatic CSRF token injection for state-mutating
 * requests and consistent JSON error handling.
 */

function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.content : null;
}

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

// ─── Session id resolver ──────────────────────────────────────────────
// Callsites still hold friendly names (tile ids, URL params, etc.) but
// the server's name-keyed routes are being retired. Resolve name → id
// once and let callers hit /sessions/by-id/:id/*. Cache is in-memory
// only, and we only cache individual name→id hits — renames invalidate
// the entry via invalidateSessionIdCache(name). Deletes do the same.
const sessionIdByName = new Map();

/**
 * Resolve a session friendly name to its surrogate id.
 * Throws if the session does not exist.
 *
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function resolveSessionId(name) {
  if (sessionIdByName.has(name)) return sessionIdByName.get(name);
  const sessions = await api.get("/sessions");
  if (!Array.isArray(sessions)) throw new Error("Unexpected /sessions response");
  // Repopulate the whole cache from this fetch so follow-up lookups are free.
  sessionIdByName.clear();
  for (const s of sessions) {
    if (s && typeof s.name === "string" && typeof s.id === "string") {
      sessionIdByName.set(s.name, s.id);
    }
  }
  const id = sessionIdByName.get(name);
  if (!id) throw new Error(`Session not found: ${name}`);
  return id;
}

/** Drop cache entries — call after rename/delete so stale names don't resolve. */
export function invalidateSessionIdCache(name) {
  if (name === undefined) sessionIdByName.clear();
  else sessionIdByName.delete(name);
}
