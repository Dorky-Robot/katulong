/**
 * Peers picker — modal that lists peer katulong instances and their
 * live sessions, so the user can tap to open one as a `remote-terminal`
 * tile here. iPad-friendly tap path; no dev-console needed.
 *
 * Wiring (in app.js)
 *   const picker = createPeersPicker({
 *     rootEl: document.getElementById("peers-picker-list"),
 *     closeBtn: document.getElementById("peers-picker-close-btn"),
 *     api,
 *     onClose: () => modals.close('peers'),
 *     openRemote: ({ peerUrl, apiKey, session, label }) => {
 *       uiStore.addTile({...}, {focus:true,insertAt:"afterFocus"});
 *     },
 *   });
 *   modals.register('peers', 'peers-picker-overlay', { onOpen: () => picker.refresh() });
 *
 * Wire shape it talks to (server side: lib/routes/peers-routes.js):
 *   GET /api/peers              — list peers (no apiKey)
 *   GET /api/peers/:id/sessions — peer's live sessions
 *   GET /api/peers/:id/credentials — { peerUrl, apiKey, label }
 *
 * Why two `api` calls per session-open
 *   The picker's session-list call gets the public-shape sessions list
 *   (no apiKey). Only when the user actually picks a session do we
 *   fetch credentials and hand them to the renderer. That keeps the
 *   apiKey server-side until the moment a tile actually wants to attach.
 */

export function createPeersPicker({ rootEl, closeBtn, api, openRemote, onClose }) {
  if (!rootEl) throw new Error("createPeersPicker: rootEl required");
  if (!api || typeof api.get !== "function") {
    throw new Error("createPeersPicker: api with .get() required");
  }
  if (typeof openRemote !== "function") {
    throw new Error("createPeersPicker: openRemote callback required");
  }

  // Map peerId → expanded?  controls inline session-list expansion.
  const expanded = new Set();
  // Cache session list per peer for the lifetime of the modal.
  // Cleared on each refresh() — a refresh means the user came back
  // and we want fresh data, not stale cached data.
  const sessionsByPeer = new Map();

  function clearRoot() {
    while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
  }

  function renderEmpty(message) {
    clearRoot();
    const empty = document.createElement("div");
    empty.className = "peers-picker-empty";
    empty.textContent = message;
    rootEl.appendChild(empty);
  }

  function renderError(message) {
    // Distinct from empty so the user can tell "no peers configured"
    // (do something) from "couldn't reach peers route" (retry).
    clearRoot();
    const err = document.createElement("div");
    err.className = "peers-picker-error";
    err.textContent = message;
    rootEl.appendChild(err);
  }

  async function refresh() {
    expanded.clear();
    sessionsByPeer.clear();
    clearRoot();

    let resp;
    try { resp = await api.get("/api/peers"); }
    catch (err) {
      renderError(`Could not load peers: ${err?.message || err}`);
      return;
    }
    const peers = (resp && Array.isArray(resp.peers)) ? resp.peers : [];
    if (peers.length === 0) {
      renderEmpty("No peers configured. Use `katulong peers add` or PUT /api/config/peers to add one.");
      return;
    }

    for (const peer of peers) {
      rootEl.appendChild(renderPeerRow(peer));
    }
  }

  function renderPeerRow(peer) {
    const wrap = document.createElement("div");
    wrap.className = "peers-picker-peer";
    wrap.setAttribute("data-peer-id", peer.id);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "peers-picker-peer-header";
    header.textContent = peer.label || peer.id;
    const sub = document.createElement("span");
    sub.className = "peers-picker-peer-url";
    sub.textContent = peer.url;
    header.appendChild(sub);

    const sessionsList = document.createElement("div");
    sessionsList.className = "peers-picker-sessions";
    sessionsList.setAttribute("data-role", "sessions");
    sessionsList.style.display = "none";

    header.addEventListener("click", () => togglePeer(peer, sessionsList));

    wrap.appendChild(header);
    wrap.appendChild(sessionsList);
    return wrap;
  }

  async function togglePeer(peer, sessionsList) {
    if (expanded.has(peer.id)) {
      expanded.delete(peer.id);
      sessionsList.style.display = "none";
      return;
    }
    expanded.add(peer.id);
    sessionsList.style.display = "block";

    if (sessionsByPeer.has(peer.id)) {
      renderSessions(peer, sessionsByPeer.get(peer.id), sessionsList);
      return;
    }

    // Show a loading row while we fetch
    while (sessionsList.firstChild) sessionsList.removeChild(sessionsList.firstChild);
    const loading = document.createElement("div");
    loading.className = "peers-picker-session-loading";
    loading.textContent = "Loading sessions…";
    sessionsList.appendChild(loading);

    let resp;
    try { resp = await api.get(`/api/peers/${encodeURIComponent(peer.id)}/sessions`); }
    catch (err) {
      while (sessionsList.firstChild) sessionsList.removeChild(sessionsList.firstChild);
      const errEl = document.createElement("div");
      errEl.className = "peers-picker-session-error";
      errEl.textContent = `Could not load sessions: ${err?.message || err}`;
      sessionsList.appendChild(errEl);
      return;
    }
    const sessions = (resp && Array.isArray(resp.sessions)) ? resp.sessions : [];
    sessionsByPeer.set(peer.id, sessions);
    renderSessions(peer, sessions, sessionsList);
  }

  function renderSessions(peer, sessions, sessionsList) {
    while (sessionsList.firstChild) sessionsList.removeChild(sessionsList.firstChild);
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "peers-picker-session-empty";
      empty.textContent = "No live sessions on this peer.";
      sessionsList.appendChild(empty);
      return;
    }
    for (const session of sessions) {
      sessionsList.appendChild(renderSessionRow(peer, session));
    }
  }

  function renderSessionRow(peer, session) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "peers-picker-session";
    btn.setAttribute("data-session-name", session.name);
    btn.disabled = !session.alive;

    const name = document.createElement("span");
    name.className = "peers-picker-session-name";
    name.textContent = session.name;
    btn.appendChild(name);

    if (session.title) {
      const title = document.createElement("span");
      title.className = "peers-picker-session-title";
      title.textContent = session.title;
      btn.appendChild(title);
    }

    if (!session.alive) {
      const dead = document.createElement("span");
      dead.className = "peers-picker-session-dead";
      dead.textContent = "(stopped)";
      btn.appendChild(dead);
    }

    btn.addEventListener("click", () => pickSession(peer, session));
    return btn;
  }

  async function pickSession(peer, session) {
    let creds;
    try {
      creds = await api.get(`/api/peers/${encodeURIComponent(peer.id)}/credentials`);
    } catch (err) {
      // Bubble up via the existing error row mechanism — replace the
      // whole peer's session list area with the error so the user sees
      // it without scrolling.
      const wrap = rootEl.querySelector(`[data-peer-id="${cssEscape(peer.id)}"] [data-role="sessions"]`);
      if (wrap) {
        while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
        const errEl = document.createElement("div");
        errEl.className = "peers-picker-session-error";
        errEl.textContent = `Could not get credentials: ${err?.message || err}`;
        wrap.appendChild(errEl);
      }
      return;
    }
    if (!creds || !creds.peerUrl || !creds.apiKey) {
      // Server returned a malformed credentials shape — refuse to spawn
      // a tile that will silently fail.
      return;
    }
    openRemote({
      peerUrl: creds.peerUrl,
      apiKey: creds.apiKey,
      session: session.name,
      label: session.title
        ? `${creds.label || peer.id} · ${session.title}`
        : `${creds.label || peer.id} · ${session.name}`,
    });
    if (onClose) onClose();
  }

  // Minimal CSS.escape polyfill — Safari has it but our FakeElement
  // querySelector tests don't require a particular form. The peer ids
  // are validated server-side to [a-zA-Z0-9._-] so this is purely
  // defense in depth against future id alphabet changes.
  function cssEscape(s) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      if (onClose) onClose();
    });
  }

  return { refresh };
}
