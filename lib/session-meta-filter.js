/**
 * Shared filter for session.meta before it leaves the server.
 *
 * Some meta keys are server-only (e.g., `transcriptPath` — an absolute
 * host filesystem path used for reading Claude transcripts but never
 * meant for clients). Any code path that ships meta over the wire —
 * REST responses, WS pushes — must funnel through `publicMeta` so a
 * single list of private keys governs every outbound surface.
 *
 * Session meta is structured as `{ [namespace]: { ...fields } }` (e.g.,
 * `meta.claude = { uuid, transcriptPath, ... }`), so the filter strips
 * private keys at the top level AND one level deep inside plain-object
 * namespaces. Arrays and non-plain values pass through unchanged.
 *
 * Kept in its own module so both `session-manager.js` (WS `session-updated`
 * push) and `routes/app-routes.js` (REST responses) can share the filter
 * without one importing from the other.
 */

export const PRIVATE_META_KEYS = new Set(["transcriptPath"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stripPrivateKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PRIVATE_META_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function publicMeta(meta) {
  if (!isPlainObject(meta)) return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (PRIVATE_META_KEYS.has(k)) continue;
    out[k] = isPlainObject(v) ? stripPrivateKeys(v) : v;
  }
  return out;
}
