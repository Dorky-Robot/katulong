/**
 * Per-Window Tab Set
 *
 * Each browser window maintains its own ordered list of session tabs.
 * State is stored in sessionStorage (per-window, survives reload).
 * BroadcastChannel coordinates session-killed events across windows.
 */

const WINDOW_ID_KEY = "katulong-window-id";
const WINDOW_TABS_KEY = "katulong-window-tabs";
const LAST_TABS_KEY = "katulong-last-tabs"; // localStorage fallback for restoring after all windows close
const CHANNEL_NAME = "katulong-tabs";

// How long a freshly-added tab stays immune to reconciler pruning. Long
// enough for the WebSocket to create the session and the next /sessions
// poll to confirm it; short enough that a stale ?s= URL bookmark becomes
// prunable within the user's "is this stuck?" attention window.
const RECENTLY_ADDED_TTL_MS = 30000;

function generateId() {
  return "w_" + Math.random().toString(36).slice(2, 10);
}

export function createWindowTabSet({ getCurrentSession } = {}) {
  const windowId = sessionStorage.getItem(WINDOW_ID_KEY) || generateId();
  sessionStorage.setItem(WINDOW_ID_KEY, windowId);

  let tabs = loadTabs();
  saveTabs(); // Persist initial seed so navigations within this tab preserve it
  const subscribers = new Set();
  // Tabs added locally that the server hasn't yet confirmed in /sessions.
  // The reconciler in app.js reads this via isRecentlyAdded() to skip
  // just-created sessions during its prune pass — without it, a brand-new
  // tab could be pruned in the gap between local creation and the next
  // server response. Grace is time-limited (RECENTLY_ADDED_TTL_MS) so
  // stale ?s= URL bookmarks eventually become prunable instead of
  // remaining permanently immune.
  const recentlyAdded = new Map(); // name -> expiresAt (ms)

  // BroadcastChannel for cross-window coordination
  let channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "session-killed" && tabs.includes(msg.sessionName)) {
        tabs = tabs.filter(n => n !== msg.sessionName);
        saveTabs();
        notify();
      }
      if (msg.type === "session-renamed") {
        const idx = tabs.indexOf(msg.oldName);
        if (idx !== -1) {
          tabs[idx] = msg.newName;
          saveTabs();
          notify();
        }
      }
    };
  } catch { /* BroadcastChannel not available — degrade gracefully */ }

  function loadTabs() {
    // 1. sessionStorage — same window/tab surviving a reload
    try {
      const saved = JSON.parse(sessionStorage.getItem(WINDOW_TABS_KEY));
      if (Array.isArray(saved) && saved.length > 0) return saved;
    } catch { /* ignore */ }
    // 2. localStorage — restore from last session after all windows closed
    try {
      const last = JSON.parse(localStorage.getItem(LAST_TABS_KEY));
      if (Array.isArray(last) && last.length > 0) return last;
    } catch { /* ignore */ }
    // 3. Seed with the current session from URL (empty if none)
    const session = getCurrentSession ? getCurrentSession() : null;
    return session ? [session] : [];
  }

  // Filter out null/undefined that may have been saved by a previous version
  tabs = tabs.filter(Boolean);

  function saveTabs() {
    sessionStorage.setItem(WINDOW_TABS_KEY, JSON.stringify(tabs));
    try { localStorage.setItem(LAST_TABS_KEY, JSON.stringify(tabs)); } catch { /* ignore */ }
  }

  function notify() {
    for (const fn of subscribers) fn(tabs);
  }

  return {
    windowId,

    getTabs() { return [...tabs]; },

    hasTab(name) { return tabs.includes(name); },

    addTab(name, position) {
      if (tabs.includes(name)) return;
      recentlyAdded.set(name, Date.now() + RECENTLY_ADDED_TTL_MS);
      if (position !== undefined && position >= 0) {
        tabs.splice(position, 0, name);
      } else {
        tabs.push(name);
      }
      saveTabs();
      notify();
    },

    removeTab(name) {
      if (!tabs.includes(name)) return;
      tabs = tabs.filter(n => n !== name);
      recentlyAdded.delete(name);
      saveTabs();
      notify();
    },

    reorderTabs(orderedNames) {
      tabs = orderedNames.filter(n => tabs.includes(n));
      saveTabs();
      notify();
    },

    renameTab(oldName, newName) {
      const idx = tabs.indexOf(oldName);
      if (idx === -1) return;
      tabs[idx] = newName;
      recentlyAdded.set(newName, Date.now() + RECENTLY_ADDED_TTL_MS);
      recentlyAdded.delete(oldName);
      saveTabs();
      notify();
      if (channel) {
        channel.postMessage({ type: "session-renamed", oldName, newName });
      }
    },

    /** Kill: remove from all windows via broadcast */
    onSessionKilled(name) {
      tabs = tabs.filter(n => n !== name);
      recentlyAdded.delete(name);
      saveTabs();
      notify();
      if (channel) {
        channel.postMessage({ type: "session-killed", sessionName: name });
      }
    },

    /** Sessions managed by the server but not in this window's tab set */
    getAvailableSessions(allSessions) {
      return allSessions.filter(s => !tabs.includes(s.name));
    },

    /** Whether a tab name is in the local "just added" grace period.
     *  Used by the tile reconciler to skip pruning sessions the server
     *  may not yet have caught up to. Grace expires after the TTL so
     *  stale URL bookmarks eventually become prunable; expired entries
     *  are dropped lazily on read. */
    isRecentlyAdded(name) {
      const expiresAt = recentlyAdded.get(name);
      if (expiresAt === undefined) return false;
      if (Date.now() >= expiresAt) {
        recentlyAdded.delete(name);
        return false;
      }
      return true;
    },

    /** Mark a tab as confirmed by the server, ending its grace period. */
    confirmTab(name) {
      recentlyAdded.delete(name);
    },

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    destroy() {
      if (channel) channel.close();
      subscribers.clear();
    }
  };
}
