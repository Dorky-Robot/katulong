/**
 * Session Status Watcher
 *
 * One poller per session. Terminal tiles and dashboard back tiles
 * used to each run their own 5s `setInterval` against
 * `/sessions/:name/status`, which meant two timers per terminal card
 * and two independent copies of `prevHasChildProcesses`. When the
 * card flipped to its back face both pollers would be active at once,
 * so whichever one fired first reset the other's transition detector
 * and the auto-flip-on-idle could go missed or duplicated.
 *
 * This module centralizes that polling. The tile that "owns" the
 * session (terminal-tile) creates the watcher at mount time and
 * destroys it at unmount. The back tile subscribes instead of
 * running its own interval. Rename is plumbed through
 * `setSessionName()` so subsequent polls hit the new URL.
 *
 * The watcher never decides *what* should happen on a transition —
 * subscribers do. The watcher just reports:
 *   { status, transitions: { idle, active, exited } }
 * where `status` is the parsed JSON (or null on error) and the
 * transitions are booleans computed against the previous poll.
 *
 * Subscribers receive the raw event. Terminal-tile reacts to
 * `transitions.idle` with a 1.5s debounce and a carousel flip.
 * Dashboard back tile uses `status` to update its DOM and
 * `transitions.idle` to append a timeline event. Neither one keeps
 * its own `prevHasChildProcesses`.
 *
 * The `destroyed` flag guards async callbacks that land after
 * destroy() — clearInterval can't cancel an already-awaited fetch
 * `.then()`, so the promise chain may resolve against a watcher
 * whose subscribers are stale. Mirrors the pattern that e26d706
 * introduced in terminal-tile and dashboard-back-tile.
 */

/**
 * @param {object} options
 * @param {string} options.sessionName — session to poll
 * @param {number} [options.interval=5000] — poll interval in ms
 * @param {typeof fetch} [options.fetchImpl] — injectable for tests
 * @returns {{
 *   subscribe: (fn: (event) => void) => () => void,
 *   setSessionName: (newName: string) => void,
 *   destroy: () => void,
 *   poll: () => Promise<void>,
 * }}
 */
export function createSessionStatusWatcher({
  sessionName,
  interval = 5000,
  fetchImpl,
} = {}) {
  let currentSessionName = sessionName;
  const doFetch = fetchImpl || ((url) => globalThis.fetch(url));
  const subscribers = new Set();
  let destroyed = false;
  let timer = null;
  let prevHasChildProcesses = false;
  let prevAlive = true;

  async function poll() {
    if (destroyed) return;
    let status = null;
    try {
      const res = await doFetch(`/sessions/${encodeURIComponent(currentSessionName)}/status`);
      if (destroyed) return;
      if (!res.ok) {
        notify({ status: null, transitions: {}, error: new Error(`HTTP ${res.status}`) });
        return;
      }
      status = await res.json();
      if (destroyed) return;
    } catch (err) {
      if (destroyed) return;
      notify({ status: null, transitions: {}, error: err });
      return;
    }

    const hasChild = !!status.hasChildProcesses;
    const alive = status.alive !== false;
    const transitions = {
      idle: prevHasChildProcesses && !hasChild,
      active: !prevHasChildProcesses && hasChild,
      exited: prevAlive && !alive,
    };
    prevHasChildProcesses = hasChild;
    prevAlive = alive;

    notify({ status, transitions });
  }

  function notify(event) {
    for (const fn of subscribers) {
      // Subscribers are not allowed to throw — but if they do, we
      // isolate so one bad subscriber can't starve the others.
      try { fn(event); } catch { /* swallow */ }
    }
  }

  function start() {
    if (timer || destroyed) return;
    timer = setInterval(poll, interval);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    subscribe(fn) {
      if (destroyed) return () => {};
      subscribers.add(fn);
      if (subscribers.size === 1) start();
      return function unsubscribe() {
        subscribers.delete(fn);
        if (subscribers.size === 0) stop();
      };
    },

    setSessionName(newName) {
      currentSessionName = newName;
    },

    destroy() {
      destroyed = true;
      stop();
      subscribers.clear();
    },

    /** Manual poll — used by tests and by eager first-poll on mount. */
    poll,

    get sessionName() { return currentSessionName; },
  };
}
