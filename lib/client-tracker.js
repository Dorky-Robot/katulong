/**
 * Client Tracker
 *
 * Tracks which WebSocket clients are attached to which terminal sessions,
 * manages active-client election (most recently interacting client controls
 * tmux dimensions), and coordinates resize arbitration between multiple
 * clients viewing the same session.
 *
 * Extracted from session-manager.js to separate client multiplexing
 * concerns from session lifecycle management.
 */

/**
 * Create a client tracker.
 *
 * @param {object} opts
 * @param {object} opts.bridge - Transport bridge for relaying resize-sync events
 * @param {function} opts.getSession - Look up a session by name: (name) => Session|undefined
 * @returns {object} Client tracker API
 */
export function createClientTracker({ bridge, getSession }) {
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
   * Mark a client as active and broadcast resize-sync if this client
   * becomes the new active client with different dimensions.
   * @param {string} clientId
   */
  function markActive(clientId) {
    const info = clients.get(clientId);
    if (!info) return;
    const prevActive = getActiveClient(info.session);
    info.lastActiveAt = Date.now();
    const nowActive = getActiveClient(info.session);

    if (prevActive !== nowActive && info.cols && info.rows) {
      const session = getSession(info.session);
      if (session?.alive) {
        session.resize(info.cols, info.rows);
      }
      bridge.relay({
        type: "resize-sync",
        session: info.session,
        cols: info.cols,
        rows: info.rows,
        activeClientId: nowActive,
      });
    }
  }

  /**
   * Register a client as attached to a session.
   * If the client is already attached to a different session, detaches first.
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
    clients.set(clientId, { session: sessionName, lastActiveAt: 0, cols, rows });
    markActive(clientId);
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
          bridge.relay({
            type: "resize-sync",
            session: info.session,
            cols: newInfo.cols,
            rows: newInfo.rows,
            activeClientId: newActiveId,
          });
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

      if (clientCount(info.session) > 1) {
        bridge.relay({
          type: "resize-sync",
          session: info.session,
          cols,
          rows,
          activeClientId: clientId,
        });
      }
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
