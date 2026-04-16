/**
 * Shared fetch for the server's two session lists.
 *
 * Both the shortcut-bar + button dropdown and the Cmd+/ fuzzy picker
 * need the same pair: managed sessions (/sessions) and unmanaged tmux
 * sessions (/tmux-sessions). The normalization (tmux list occasionally
 * returns plain strings instead of objects) was duplicated verbatim in
 * two places until we hoisted it here.
 *
 * Errors from either endpoint degrade to an empty list rather than
 * aborting the whole fetch — showing half the picker is strictly better
 * than showing none of it. Shortcut-bar previously used an outer
 * try/catch that zeroed both lists when either endpoint failed; the
 * per-fetch .catch here intentionally preserves partial results, which
 * is the behavior openTilePicker already had.
 */

import { api } from "/lib/api-client.js";

export async function fetchSessionLists() {
  const cacheBust = Date.now();
  const [sessData, tmuxData] = await Promise.all([
    api.get(`/sessions?_t=${cacheBust}`).catch((err) => {
      console.warn("[session-fetch] /sessions failed:", err.message);
      return [];
    }),
    api.get(`/tmux-sessions?_t=${cacheBust}`).catch((err) => {
      console.warn("[session-fetch] /tmux-sessions failed:", err.message);
      return [];
    }),
  ]);
  const managed = sessData || [];
  const unmanaged = (tmuxData || []).map(
    (s) => typeof s === "string" ? { name: s, attached: false } : s,
  );
  return { managed, unmanaged };
}
