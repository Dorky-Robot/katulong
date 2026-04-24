/**
 * History tile renderer.
 *
 * Renders the rolling timeline of auto-generated summaries for a
 * terminal session, so the user can answer "what was I doing an hour
 * ago?" at a glance. The summarizer (lib/session-summarizer.js) writes
 * each new distinct summary to `session.meta.summaryHistory`; this
 * tile subscribes to the session store and re-renders on every
 * session-updated broadcast, so new entries land live without
 * per-tile polling.
 *
 * Props:
 *   sessionName: string  — the session to describe. Falsy → "pick a
 *                          session" affordance (the user opened the
 *                          history tile with no active terminal).
 */

let _getSessionStore = null;

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = String(str ?? "");
  return el.innerHTML;
}

function formatRelative(at) {
  if (!Number.isFinite(at)) return "";
  const diff = Date.now() - at;
  if (diff < 15_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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
    const sessionName = props?.sessionName || null;
    const store = _getSessionStore ? _getSessionStore() : null;

    const root = document.createElement("div");
    root.className = "history-tile-root";
    el.appendChild(root);

    let destroyed = false;
    let relTimer = null;

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
      const history = Array.isArray(session?.meta?.summaryHistory)
        ? session.meta.summaryHistory
        : [];
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

    render();

    // Subscribe for live updates. Session store broadcasts a full
    // sessions array on every change, so we just re-render — the cost
    // is a single innerHTML assignment, negligible next to the live
    // terminal.
    const unsubscribe = store?.subscribe ? store.subscribe(render) : null;

    // Refresh the relative timestamps once a minute. Cheap: re-render
    // a small DOM subtree; no network, no computation.
    relTimer = setInterval(render, 60_000);

    return {
      unmount() {
        destroyed = true;
        if (relTimer) { clearInterval(relTimer); relTimer = null; }
        unsubscribe?.();
        root.remove();
      },
      focus() {},
      blur() {},
      resize() {},
    };
  },
};
