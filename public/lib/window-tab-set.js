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

function generateId() {
  return "w_" + Math.random().toString(36).slice(2, 10);
}

export function createWindowTabSet({ sessionStore, getCurrentSession }) {
  const windowId = sessionStorage.getItem(WINDOW_ID_KEY) || generateId();
  sessionStorage.setItem(WINDOW_ID_KEY, windowId);

  let tabs = loadTabs();
  saveTabs(); // Persist initial seed so navigations within this tab preserve it
  const subscribers = new Set();
  // Protect from stale-data prune until the server confirms them.
  // Only the current session needs protection (may be new, not yet in server response).
  const currentSession = getCurrentSession ? getCurrentSession() : null;
  const recentlyAdded = new Set(currentSession ? [currentSession] : []);

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
    };
  } catch { /* BroadcastChannel not available — degrade gracefully */ }

  // Prune tabs when sessions disappear from the server
  if (sessionStore) {
    sessionStore.subscribe(() => {
      const { sessions: serverList, loading } = sessionStore.getState();
      // Don't prune while loading or before first fetch completes
      if (loading || !serverList || serverList.length === 0) return;
      const serverSessions = new Set(serverList.map(s => s.name));
      const before = tabs.length;
      // Keep recently-added tabs that the server hasn't confirmed yet
      tabs = tabs.filter(n => serverSessions.has(n) || recentlyAdded.has(n));
      // Clear recently-added for names the server now knows about
      for (const n of recentlyAdded) {
        if (serverSessions.has(n)) recentlyAdded.delete(n);
      }
      if (tabs.length !== before) {
        saveTabs();
        notify();
      }
    });
  }

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
    // 3. Seed with the current session from URL
    const session = getCurrentSession ? getCurrentSession() : "default";
    return [session];
  }

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
      recentlyAdded.add(name);
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
      saveTabs();
      notify();
    },

    reorderTabs(orderedNames) {
      tabs = orderedNames.filter(n => tabs.includes(n));
      saveTabs();
      notify();
    },

    /** Kill: remove from all windows via broadcast */
    onSessionKilled(name) {
      tabs = tabs.filter(n => n !== name);
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
