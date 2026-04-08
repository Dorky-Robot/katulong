/**
 * Tests for SessionStatusWatcher — the single-poller-per-session
 * helper that terminal-tile and dashboard-back-tile now share.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { createSessionStatusWatcher } from '../public/lib/session-status-watcher.js';

function makeFetchScript(statuses) {
  let i = 0;
  return mock.fn(async (_url) => {
    const s = statuses[Math.min(i, statuses.length - 1)];
    i++;
    if (s?.throw) throw s.throw;
    if (s?.ok === false) return { ok: false, status: s.status || 500 };
    return { ok: true, json: async () => s };
  });
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe('SessionStatusWatcher', () => {
  let timers;

  beforeEach(() => {
    timers = mock.timers;
    timers.enable({ apis: ['setInterval', 'setTimeout'] });
  });

  afterEach(() => {
    timers.reset();
  });

  it('polls only once per interval regardless of subscriber count', async () => {
    const fetchImpl = makeFetchScript([
      { alive: true, hasChildProcesses: true },
      { alive: true, hasChildProcesses: false },
    ]);
    const watcher = createSessionStatusWatcher({ sessionName: "dev", fetchImpl });
    const a = mock.fn();
    const b = mock.fn();
    const c = mock.fn();
    watcher.subscribe(a);
    watcher.subscribe(b);
    watcher.subscribe(c);

    timers.tick(5000);
    await flush();

    // One fetch, three notifications
    assert.strictEqual(fetchImpl.mock.callCount(), 1);
    assert.strictEqual(a.mock.callCount(), 1);
    assert.strictEqual(b.mock.callCount(), 1);
    assert.strictEqual(c.mock.callCount(), 1);
    watcher.destroy();
  });

  it('emits transitions.idle on had-children → no-children', async () => {
    const fetchImpl = makeFetchScript([
      { alive: true, hasChildProcesses: true },
      { alive: true, hasChildProcesses: false },
    ]);
    const watcher = createSessionStatusWatcher({ sessionName: "dev", fetchImpl });
    const events = [];
    watcher.subscribe(e => events.push(e));

    timers.tick(5000);
    await flush();
    timers.tick(5000);
    await flush();

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].transitions.idle, false);
    assert.strictEqual(events[0].transitions.active, true);
    assert.strictEqual(events[1].transitions.idle, true);
    assert.strictEqual(events[1].transitions.active, false);
    watcher.destroy();
  });

  it('emits transitions.exited on alive → !alive', async () => {
    const fetchImpl = makeFetchScript([
      { alive: true, hasChildProcesses: false },
      { alive: false, hasChildProcesses: false },
    ]);
    const watcher = createSessionStatusWatcher({ sessionName: "dev", fetchImpl });
    const events = [];
    watcher.subscribe(e => events.push(e));

    timers.tick(5000);
    await flush();
    timers.tick(5000);
    await flush();

    assert.strictEqual(events[1].transitions.exited, true);
    watcher.destroy();
  });

  it('stops polling when last subscriber unsubscribes', async () => {
    const fetchImpl = makeFetchScript([{ alive: true, hasChildProcesses: false }]);
    const watcher = createSessionStatusWatcher({ sessionName: "dev", fetchImpl });
    const unsubscribe = watcher.subscribe(() => {});
    timers.tick(5000);
    await flush();
    assert.strictEqual(fetchImpl.mock.callCount(), 1);

    unsubscribe();
    timers.tick(10000);
    await flush();
    // No additional fetches after unsubscribe
    assert.strictEqual(fetchImpl.mock.callCount(), 1);
    watcher.destroy();
  });

  it('destroy() prevents any further notifications even if a fetch is in flight', async () => {
    let resolveFetch;
    const fetchImpl = mock.fn(() => new Promise(r => { resolveFetch = r; }));
    const watcher = createSessionStatusWatcher({ sessionName: "dev", fetchImpl });
    const events = [];
    watcher.subscribe(e => events.push(e));

    timers.tick(5000);
    // Fetch is awaiting; destroy before it resolves
    watcher.destroy();
    resolveFetch({ ok: true, json: async () => ({ alive: true, hasChildProcesses: false }) });
    await flush();

    assert.strictEqual(events.length, 0);
  });

  it('setSessionName updates the URL for subsequent polls', async () => {
    const fetchImpl = makeFetchScript([
      { alive: true, hasChildProcesses: false },
      { alive: true, hasChildProcesses: false },
    ]);
    const watcher = createSessionStatusWatcher({ sessionName: "old", fetchImpl });
    watcher.subscribe(() => {});
    timers.tick(5000);
    await flush();

    watcher.setSessionName("new");
    timers.tick(5000);
    await flush();

    assert.strictEqual(fetchImpl.mock.calls[0].arguments[0], "/sessions/old/status");
    assert.strictEqual(fetchImpl.mock.calls[1].arguments[0], "/sessions/new/status");
    watcher.destroy();
  });

  it('swallows subscriber errors without blocking other subscribers', async () => {
    const fetchImpl = makeFetchScript([{ alive: true, hasChildProcesses: false }]);
    const watcher = createSessionStatusWatcher({ sessionName: "dev", fetchImpl });
    const bad = mock.fn(() => { throw new Error("boom"); });
    const good = mock.fn();
    watcher.subscribe(bad);
    watcher.subscribe(good);
    timers.tick(5000);
    await flush();
    assert.strictEqual(good.mock.callCount(), 1);
    watcher.destroy();
  });

  it('reports error events on fetch failure without crashing', async () => {
    const fetchImpl = makeFetchScript([
      { throw: new Error("network down") },
    ]);
    const watcher = createSessionStatusWatcher({ sessionName: "dev", fetchImpl });
    const events = [];
    watcher.subscribe(e => events.push(e));
    timers.tick(5000);
    await flush();
    assert.strictEqual(events.length, 1);
    assert.ok(events[0].error);
    assert.strictEqual(events[0].status, null);
    watcher.destroy();
  });
});
