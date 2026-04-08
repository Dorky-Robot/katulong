/**
 * Client Tracker
 *
 * Tracks which clients are attached to which terminal sessions,
 * manages active-client election (most recently interacting client wins
 * resize arbitration), and coordinates resize events between multiple
 * clients viewing the same session.  Switching the active client does NOT
 * resize tmux — only explicit lifecycle events (attach, detach, resize
 * message) trigger tmux resize.
 *
 * Raptor 3: the tracker used to relay `resize-sync` events on the bridge
 * so inactive clients could refit their xterm to the new shared dims.
 * That path is gone — Session._applyResize now fires an `onSnapshot`
 * callback which session-manager relays as a `snapshot` message, and
 * that message is the only signal clients need to transition dims.
 * The tracker stays focused on "who is attached, who is active" and
 * leaves dim transitions entirely to Session.
 *
 * Extracted from session-manager.js to separate client multiplexing
 * concerns from session lifecycle management.
 */

/**
 * Create a client tracker.
 *
 * @param {object} opts
 * @param {function} opts.getSession - Look up a session by name: (name) => Session|undefined
 * @returns {object} Client tracker API
 */
export function createClientTracker({ getSession }) {
  const clients = new Map(); // clientId -> { session, lastActiveAt, cols, rows }

  /**
   * Get the active (most recently interacting) client for a session.
   * @param {string} sessionName
   * @returns {string|null} clientId of the active client
   */
  function getActiveClient(sessionName) {
    let activeId = null;
    let latestTime = 0;
    for (const [cid, info] of clients) {
      if (info.session === sessionName && info.lastActiveAt > latestTime) {
        latestTime = info.lastActiveAt;
        activeId = cid;
      }
    }
    return activeId;
  }

  /**
   * Count how many clients are attached to a session.
   * @param {string} sessionName
   * @returns {number}
   */
  function clientCount(sessionName) {
    let count = 0;
    for (const [, info] of clients) {
      if (info.session === sessionName) count++;
    }
    return count;
  }

  /**
   * Check if any clients are attached to a session.
   * @param {string} sessionName
   * @returns {boolean}
   */
  function hasClients(sessionName) {
    for (const [, info] of clients) {
      if (info.session === sessionName) return true;
    }
    return false;
  }

  /**
   * Mark a client as active.  Does NOT resize tmux — resizing only
   * happens on explicit attach or client-initiated resize messages.
   * This prevents SIGWINCH storms when switching between devices with
   * different screen sizes, which garbles TUI apps (vim, htop, diwa).
   * @param {string} clientId
   */
  function markActive(clientId) {
    const info = clients.get(clientId);
    if (!info) return;
    info.lastActiveAt = Date.now();
  }

  /**
   * Register a client as attached to a session.
   * If the client is already attached to a different session, detaches first.
   * Attach is an explicit event so it resizes tmux to the client's dimensions.
   * The resize flows through Session._applyResize → onSnapshot → bridge,
   * which broadcasts the new state to every OTHER client subscribed to
   * this session. The attaching client receives the initial snapshot
   * directly via the attachClient() return value.
   *
   * @param {string} clientId
   * @param {string} sessionName
   * @param {number} cols
   * @param {number} rows
   */
  function attach(clientId, sessionName, cols, rows) {
    const existing = clients.get(clientId);
    if (existing && existing.session !== sessionName) {
      detach(clientId);
    }
    clients.set(clientId, { session: sessionName, lastActiveAt: Date.now(), cols, rows });

    // Attach is an explicit client event — resize immediately so the
    // new client's dimensions take effect without waiting for a keypress.
    if (cols && rows) {
      const session = getSession(sessionName);
      if (session?.alive) session.resize(cols, rows);
    }
  }

  /**
   * Detach a client. If it was the active client, promotes the next one.
   * @param {string} clientId
   */
  function detach(clientId) {
    const info = clients.get(clientId);
    if (!info) return;

    const wasActive = getActiveClient(info.session) === clientId;
    clients.delete(clientId);

    if (wasActive) {
      const newActiveId = getActiveClient(info.session);
      if (newActiveId) {
        const newInfo = clients.get(newActiveId);
        if (newInfo?.cols && newInfo?.rows) {
          const session = getSession(info.session);
          if (session?.alive) {
            session.resize(newInfo.cols, newInfo.rows);
          }
        }
      }
    }
  }

  /**
   * Remove all clients attached to a session.
   * @param {string} sessionName
   */
  function detachAll(sessionName) {
    for (const [cid, info] of [...clients]) {
      if (info.session === sessionName) clients.delete(cid);
    }
  }

  /**
   * Rename a session for all attached clients.
   * @param {string} oldName
   * @param {string} newName
   */
  function renameSession(oldName, newName) {
    for (const [, info] of clients) {
      if (info.session === oldName) info.session = newName;
    }
  }

  /**
   * Resize: update stored dimensions and apply to tmux if this is the active client.
   * @param {string} clientId
   * @param {number} cols
   * @param {number} rows
   */
  function resize(clientId, cols, rows) {
    const info = clients.get(clientId);
    if (!info) return;

    info.cols = cols;
    info.rows = rows;

    const activeId = getActiveClient(info.session);
    if (activeId === clientId || clientCount(info.session) <= 1) {
      const session = getSession(info.session);
      if (session?.alive) session.resize(cols, rows);
    }
  }

  /**
   * Get the session name a client is attached to.
   * @param {string} clientId
   * @returns {string|null}
   */
  function getSessionFor(clientId) {
    return clients.get(clientId)?.session || null;
  }

  return {
    attach,
    detach,
    detachAll,
    renameSession,
    resize,
    markActive,
    getActiveClient,
    clientCount,
    hasClients,
    getSessionFor,
  };
}
