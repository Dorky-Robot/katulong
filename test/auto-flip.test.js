/**
 * Characterization test for the terminal-tile auto-flip-on-idle UX.
 *
 * When a terminal session's child processes transition from alive to
 * dead, the terminal tile flips the carousel card to its dashboard back
 * face after a 1.5s debounce. This behavior was preserved deliberately
 * in e26d706 ("Tier 1 correctness pass before tile clusters") which
 * added the `destroyed` guard to block callbacks after unmount.
 *
 * This test pins the behavior so that Phase 1.2 (consolidate status
 * polling into a single SessionStatusWatcher) does not regress it.
 *
 * The test uses mock timers + a mock fetch + mock carousel, not real
 * tmux or real network.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// Flush microtasks & pending I/O so that awaited fetch responses inside
// timer callbacks settle before we advance the mock clock again.
async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

// ── Mocks ────────────────────────────────────────────────────────────

function createMockElement(tag) {
  const styles = {};
  const classes = new Set();
  const children = [];
  const el = {
    tagName: (tag || "DIV").toUpperCase(),
    style: new Proxy(styles, { set: (t, k, v) => { t[k] = v; return true; }, get: (t, k) => t[k] || "" }),
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, f) => { if (f) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    className: "",
    dataset: {},
    appendChild: (child) => { children.push(child); child.parentElement = el; return child; },
    remove: () => { if (el._parentElement) el._parentElement = null; },
    querySelectorAll: () => [],
    querySelector: () => null,
    setAttribute: () => {},
    addEventListener: () => {},
    innerHTML: "",
    get parentElement() { return el._parentElement || null; },
    set parentElement(v) { el._parentElement = v; },
    _classes: classes,
    _styles: styles,
    _children: children,
  };
  return el;
}

function setupGlobals() {
  globalThis.document = globalThis.document || {};
  globalThis.document.createElement = (tag) => createMockElement(tag);
}

function createMockTerminalPool() {
  const entries = new Map();
  return {
    getOrCreate(name) {
      if (!entries.has(name)) {
        entries.set(name, {
          container: createMockElement("div"),
          term: { focus: () => {} },
        });
      }
      return entries.get(name);
    },
    get(name) { return entries.get(name); },
    protect(_name) {},
    unprotect(_name) {},
    setActive(_name) {},
    attachControls(_name) {},
    scale(_name) {},
  };
}

function createMockCarousel() {
  const flipped = new Set();
  return {
    flipCard: mock.fn((name, _isFlipped) => { flipped.add(name); }),
    isFlipped: (name) => flipped.has(name),
    setBackTile: mock.fn(),
    _flipped: flipped,
  };
}

async function importTerminalTile() {
  const url = new URL('../public/lib/tiles/terminal-tile.js', import.meta.url);
  const mod = await import(url.href + '?t=' + Date.now() + Math.random());
  return mod.createTerminalTileFactory;
}

// Poll-response script helper: step through a sequence of statuses
function makeFetchScript(statuses) {
  let i = 0;
  return mock.fn(async (_url) => {
    const s = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return { ok: true, json: async () => s };
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('terminal-tile auto-flip on idle', () => {
  let createTerminalTileFactory;
  let terminalPool;
  let carousel;
  let originalFetch;
  let timers;

  beforeEach(async () => {
    setupGlobals();
    createTerminalTileFactory = await importTerminalTile();
    terminalPool = createMockTerminalPool();
    carousel = createMockCarousel();
    originalFetch = globalThis.fetch;
    timers = mock.timers;
    timers.enable({ apis: ['setInterval', 'setTimeout'] });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    timers.reset();
  });

  it('flips to back face when child processes transition active → idle', async () => {
    // Fetch script: first poll alive with child, second poll alive without child,
    // plus the re-check fetch inside the 1.5s debounce also returns no child.
    globalThis.fetch = makeFetchScript([
      { alive: true, hasChildProcesses: true, childCount: 1 },
      { alive: true, hasChildProcesses: false, childCount: 0 },
      { alive: true, hasChildProcesses: false, childCount: 0 },
    ]);

    const factory = createTerminalTileFactory({ terminalPool, carousel });
    const tile = factory({ sessionName: "dev" });
    const container = createMockElement("div");

    tile.mount(container, { flip: () => {} });

    // Tick the 5s status poll interval to trigger first poll (active)
    timers.tick(5000);
    await flush();

    // Tick again to trigger second poll (idle transition)
    timers.tick(5000);
    await flush();

    // Debounce timer fires 1500ms later, then the inner re-check fetch
    // resolves asynchronously.
    timers.tick(1500);
    await flush();

    assert.ok(
      carousel.flipCard.mock.callCount() >= 1,
      `expected flipCard to be called at least once after idle transition, got ${carousel.flipCard.mock.callCount()}`,
    );
    assert.strictEqual(carousel.flipCard.mock.calls[0].arguments[0], "dev");
    assert.strictEqual(carousel.flipCard.mock.calls[0].arguments[1], true);
  });

  it('does not flip when the tile has been unmounted before debounce fires', async () => {
    globalThis.fetch = makeFetchScript([
      { alive: true, hasChildProcesses: true, childCount: 1 },
      { alive: true, hasChildProcesses: false, childCount: 0 },
      { alive: true, hasChildProcesses: false, childCount: 0 },
    ]);

    const factory = createTerminalTileFactory({ terminalPool, carousel });
    const tile = factory({ sessionName: "dev" });
    const container = createMockElement("div");

    tile.mount(container, { flip: () => {} });
    timers.tick(5000);
    await flush();
    timers.tick(5000);
    await flush();

    // Unmount before the 1.5s debounce fires
    tile.unmount();

    timers.tick(1500);
    await flush();

    assert.strictEqual(
      carousel.flipCard.mock.callCount(),
      0,
      'destroyed tile must not call carousel.flipCard',
    );
  });

  it('does not flip if child processes remain active', async () => {
    globalThis.fetch = makeFetchScript([
      { alive: true, hasChildProcesses: true, childCount: 1 },
      { alive: true, hasChildProcesses: true, childCount: 2 },
    ]);

    const factory = createTerminalTileFactory({ terminalPool, carousel });
    const tile = factory({ sessionName: "dev" });
    const container = createMockElement("div");

    tile.mount(container, { flip: () => {} });
    timers.tick(5000);
    await flush();
    timers.tick(5000);
    await flush();
    timers.tick(2000);
    await flush();

    assert.strictEqual(carousel.flipCard.mock.callCount(), 0);
  });
});
