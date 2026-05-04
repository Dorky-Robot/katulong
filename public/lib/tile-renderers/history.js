/**
 * History tile renderer.
 *
 * Renders the rolling timeline of auto-generated summaries for a
 * terminal session, so the user can answer "what was I doing an hour
 * ago?" at a glance. The summarizer (lib/session-summarizer.js) appends
 * each new distinct summary to a disk-backed JSONL store; this tile
 * fetches from `/sessions/by-id/:id/summaries` on mount and re-fetches
 * on every session-updated broadcast (debounced) so new entries land
 * live without per-tile polling.
 *
 * History used to live in `session.meta.summaryHistory` so the tile
 * could read it from the in-memory session object directly. That broke
 * the 4 KB meta cap once history grew past ~12 entries (every other
 * setMeta — pane, agent — failed and the status pill bar went dark);
 * the timeline is durable on disk now, and the tile pays a small fetch
 * on mount + change in exchange for unbounded honest history.
 *
 * Props:
 *   sessionName: string  — the session to describe. Falsy → "pick a
 *                          session" affordance (the user opened the
 *                          history tile with no active terminal).
 */

import { escapeHtml, formatRelativeTime } from "/lib/utils.js";
import { api, resolveSessionId } from "/lib/api-client.js";

// Module-scoped dep stash; populated by `init()` at renderer-registry
// boot. Mirrors fileBrowserRenderer / clusterRenderer / terminalRenderer,
// which all stash deps at module scope for the same reason: the renderer
// protocol separates init (dep injection) from mount (per-instance).
let _getSessionStore = null;

function formatRelative(at) {
  if (!Number.isFinite(at)) return "";
  // Sub-minute precision matters for history — "just now" vs "30s ago"
  // is the difference between "still the current task" and "just
  // finished it." The shared formatRelativeTime collapses everything
  // under a minute to "Just now," so we handle short windows inline
  // and delegate the longer ones.
  const diff = Date.now() - at;
  if (diff < 15_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  return formatRelativeTime(at);
}

function findSession(store, name) {
  if (!store || !name) return null;
  const state = store.getState();
  return (state.sessions || []).find((s) => s.name === name) || null;
}

export const historyRenderer = {
  type: "history",

  init({ getSessionStore } = {}) {
    _getSessionStore = getSessionStore || null;
  },

  describe(props) {
    const name = props?.sessionName;
    return {
      title: name ? `History · ${name}` : "History",
      icon: "clock-counter-clockwise",
      persistable: true,
      // `session: null` intentionally — this tile READS a session's
      // meta, but its tile-id is not the session name. Returning the
      // session name here would make `reconcileTilesAgainstServer`
      // treat the history tile as terminal-backed and prune it on
      // the next session-updated tick (since no session has our
      // `history-*` tile-id).
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { props }) {
    if (!_getSessionStore) throw new Error("historyRenderer.init() not called");
    const sessionName = props?.sessionName || null;
    const store = _getSessionStore();

    const root = document.createElement("div");
    root.className = "history-tile-root";
    el.appendChild(root);

    let destroyed = false;
    let relTimer = null;
    let history = [];
    // Coalesce rapid session-updated bursts (Claude streaming a long
    // turn fires many of them) into one fetch — the timeline only
    // changes ~once per 30s summarizer cycle, so 250 ms debounce is
    // ample and keeps refresh cost off the hot path.
    let refetchTimer = null;

    async function refetch() {
      if (destroyed || !sessionName) return;
      try {
        const sessionId = await resolveSessionId(sessionName);
        if (destroyed) return;
        const data = await api.get(`/sessions/by-id/${encodeURIComponent(sessionId)}/summaries`);
        if (destroyed) return;
        history = Array.isArray(data?.summaries) ? data.summaries : [];
        render();
      } catch {
        // Session not found / network blip — keep the previous render
        // rather than blanking the tile. The next session-updated tick
        // will retry.
      }
    }

    function scheduleRefetch() {
      if (refetchTimer) return;
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        refetch();
      }, 250);
    }

    function render() {
      if (destroyed) return;
      if (!sessionName) {
        root.innerHTML = `
          <div class="history-tile-empty">
            <i class="ph ph-clock-counter-clockwise"></i>
            <div>Open the history tile from a terminal's joystick to see its timeline.</div>
          </div>
        `;
        return;
      }

      const session = findSession(store, sessionName);
      const currentTitle = session?.meta?.autoTitle
        || session?.meta?.summary?.short
        || sessionName;

      if (history.length === 0) {
        root.innerHTML = `
          <div class="history-tile-header">
            <i class="ph ph-clock-counter-clockwise"></i>
            <span class="history-tile-title">${escapeHtml(currentTitle)}</span>
          </div>
          <div class="history-tile-empty">
            <div>No history yet. The summarizer writes a new entry every ~30s when the terminal changes.</div>
          </div>
        `;
        return;
      }

      // Reverse-chronological: newest on top. The ring is stored
      // oldest→newest on the server, so we reverse for display only.
      const rows = [...history].reverse().map((entry) => `
        <li class="history-tile-row">
          <div class="history-tile-row-head">
            <span class="history-tile-row-title">${escapeHtml(entry.title)}</span>
            <span class="history-tile-row-ago">${escapeHtml(formatRelative(entry.at))}</span>
          </div>
          <div class="history-tile-row-body">${escapeHtml(entry.summary)}</div>
        </li>
      `).join("");

      root.innerHTML = `
        <div class="history-tile-header">
          <i class="ph ph-clock-counter-clockwise"></i>
          <span class="history-tile-title">${escapeHtml(currentTitle)}</span>
          <span class="history-tile-count">${history.length}</span>
        </div>
        <ul class="history-tile-list">${rows}</ul>
      `;
    }

    // Initial render shows the "no history yet" / autoTitle skeleton
    // immediately while the fetch is in flight; refetch fills it in.
    render();
    refetch();

    // Subscribe for live updates. The session store still drives the
    // current-title header, and a session-updated tick is also our
    // signal that a new summary may have landed — schedule a debounced
    // refetch rather than a synchronous re-render.
    const unsubscribe = store?.subscribe ? store.subscribe(() => {
      render();
      scheduleRefetch();
    }) : null;

    // Refresh the relative timestamps once a minute. Cheap: re-render
    // a small DOM subtree; no network, no computation.
    relTimer = setInterval(render, 60_000);

    return {
      unmount() {
        destroyed = true;
        if (relTimer) { clearInterval(relTimer); relTimer = null; }
        if (refetchTimer) { clearTimeout(refetchTimer); refetchTimer = null; }
        unsubscribe?.();
        root.remove();
      },
      focus() {},
      blur() {},
      resize() {},
      // This renderer has no inner tile adapter to hand back (it's a
      // pure read-only view). Present in the return shape so callers
      // can destructure `tile` without getting `undefined`.
      tile: null,
    };
  },
};
