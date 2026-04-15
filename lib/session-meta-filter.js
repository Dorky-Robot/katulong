/**
 * Shared filter for session.meta before it leaves the server.
 *
 * Some meta keys are server-only (e.g., `transcriptPath` — an absolute
 * host filesystem path used for reading Claude transcripts but never
 * meant for clients). Any code path that ships meta over the wire —
 * REST responses, WS pushes — must funnel through `publicMeta` so a
 * single list of private keys governs every outbound surface.
 *
 * Kept in its own module so both `session-manager.js` (WS `session-updated`
 * push) and `routes/app-routes.js` (REST responses) can share the filter
 * without one importing from the other.
 */

export const PRIVATE_META_KEYS = new Set(["transcriptPath"]);

export function publicMeta(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!PRIVATE_META_KEYS.has(k)) out[k] = v;
  }
  return out;
}
