/**
 * Nudge Timer
 *
 * Polling timer with exponential backoff that sends seq-query
 * messages to detect missed output when the terminal is idle.
 */

const INITIAL_INTERVAL_MS = 2000;
const MAX_INTERVAL_MS = 60000;

export function createNudgeTimer({ getWS }) {
  let timer = null;
  let interval = INITIAL_INTERVAL_MS;
  let running = false;

  function tick() {
    const ws = getWS();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "seq-query" }));
    }
    interval = Math.min(interval * 2, MAX_INTERVAL_MS);
    timer = setTimeout(tick, interval);
  }

  return {
    /** Begin polling at 2s interval. */
    start() {
      if (running) return;
      running = true;
      interval = INITIAL_INTERVAL_MS;
      timer = setTimeout(tick, interval);
    },

    /** Called when real output arrives. Resets interval to 2s, reschedules. */
    reset() {
      if (!running) return;
      if (timer !== null) {
        clearTimeout(timer);
      }
      interval = INITIAL_INTERVAL_MS;
      timer = setTimeout(tick, interval);
    },

    /** Stop polling. */
    stop() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      interval = INITIAL_INTERVAL_MS;
    },
  };
}
