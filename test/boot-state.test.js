import { describe, it } from "node:test";
import assert from "node:assert";

// Stub localStorage before loading ui-store (which is imported by
// boot-state.js indirectly through normalize's subscribe path).
const _storage = {};
globalThis.localStorage = {
  getItem: (k) => _storage[k] ?? null,
  setItem: (k, v) => { _storage[k] = v; },
  removeItem: (k) => { delete _storage[k]; },
};

const { buildBootState } = await import(
  new URL("../public/lib/boot-state.js", import.meta.url).href
);
const { EMPTY_STATE } = await import(
  new URL("../public/lib/ui-store.js", import.meta.url).href
);

describe("buildBootState — no sources", () => {
  it("returns EMPTY_STATE when nothing is persisted and no URL hint", () => {
    const { state, migratedLegacy } = buildBootState({});
    assert.strictEqual(migratedLegacy, false);
    assert.deepStrictEqual(state.tiles, {});
    assert.strictEqual(state.focusedId, null);
  });
});

describe("buildBootState — persisted state wins", () => {
  it("uses persisted state when present, ignores legacy", () => {
    const persisted = {
      version: 2,
      activeClusterId: "default",
      clusters: { default: { id: "default" } },
      tiles: {
        a: { id: "a", type: "terminal", props: {}, x: 0, clusterId: "default" },
      },
      focusedIdByCluster: { default: "a" },
      order: ["a"],
      focusedId: "a",
    };
    const legacyCarousel = {
      tiles: [{ id: "legacy", type: "terminal", sessionName: "legacy" }],
      focused: "legacy",
    };
    const { state, migratedLegacy } = buildBootState({
      persisted,
      legacyCarousel,
      getRenderer: () => ({}),
    });
    assert.strictEqual(migratedLegacy, false);
    assert.ok(state.tiles.a);
    assert.ok(!state.tiles.legacy);
  });
});

describe("buildBootState — legacy migration", () => {
  it("migrates legacy carousel state into default cluster", () => {
    const { state, migratedLegacy } = buildBootState({
      legacyCarousel: {
        tiles: [
          { id: "s1", type: "terminal", sessionName: "s1" },
          { id: "s2", type: "terminal", sessionName: "s2" },
        ],
        focused: "s2",
      },
      getRenderer: () => ({ describe: () => ({}) }),
    });
    assert.strictEqual(migratedLegacy, true);
    assert.strictEqual(state.tiles.s1.clusterId, "default");
    assert.strictEqual(state.tiles.s2.clusterId, "default");
    assert.strictEqual(state.tiles.s1.x, 0);
    assert.strictEqual(state.tiles.s2.x, 1);
    assert.strictEqual(state.focusedId, "s2");
    // Props are stripped of id/type/cardWidth.
    assert.strictEqual(state.tiles.s1.props.sessionName, "s1");
    assert.strictEqual(state.tiles.s1.props.id, undefined);
    assert.strictEqual(state.tiles.s1.props.type, undefined);
  });

  it("maps legacy 'dashboard' type to 'cluster'", () => {
    const { state } = buildBootState({
      legacyCarousel: {
        tiles: [{ id: "d1", type: "dashboard" }],
        focused: "d1",
      },
      getRenderer: (type) => (type === "cluster" ? { describe: () => ({}) } : null),
    });
    assert.strictEqual(state.tiles.d1.type, "cluster");
  });

  it("drops tiles whose type has no renderer", () => {
    const { state } = buildBootState({
      legacyCarousel: {
        tiles: [
          { id: "ok", type: "terminal" },
          { id: "junk", type: "unknown-type" },
        ],
        focused: "ok",
      },
      getRenderer: (type) => (type === "terminal" ? { describe: () => ({}) } : null),
    });
    assert.ok(state.tiles.ok);
    assert.ok(!state.tiles.junk);
  });

  it("does not flag migration when legacy has no tiles", () => {
    const { migratedLegacy } = buildBootState({
      legacyCarousel: { tiles: [], focused: null },
    });
    assert.strictEqual(migratedLegacy, false);
  });
});

describe("buildBootState — URL session hint", () => {
  it("adds a new terminal tile and focuses it", () => {
    const { state } = buildBootState({ urlSession: "hello" });
    assert.ok(state.tiles.hello);
    assert.strictEqual(state.tiles.hello.type, "terminal");
    assert.strictEqual(state.tiles.hello.props.sessionName, "hello");
    assert.strictEqual(state.focusedId, "hello");
  });

  it("does not duplicate when the session is already present", () => {
    const persisted = {
      version: 2,
      activeClusterId: "default",
      clusters: { default: { id: "default" } },
      tiles: {
        existing: {
          id: "existing", type: "terminal", props: { sessionName: "existing" },
          x: 0, clusterId: "default",
        },
      },
      focusedIdByCluster: { default: "existing" },
      order: ["existing"],
      focusedId: "existing",
    };
    const { state } = buildBootState({ persisted, urlSession: "existing" });
    assert.strictEqual(Object.keys(state.tiles).length, 1);
    assert.strictEqual(state.focusedId, "existing");
  });

  it("preserves persisted focusedId when URL session was already present", () => {
    const persisted = {
      version: 2,
      activeClusterId: "default",
      clusters: { default: { id: "default" } },
      tiles: {
        a: { id: "a", type: "terminal", props: {}, x: 0, clusterId: "default" },
        b: { id: "b", type: "terminal", props: {}, x: 1, clusterId: "default" },
      },
      focusedIdByCluster: { default: "b" },
      order: ["a", "b"],
      focusedId: "b",
    };
    // User refreshed with ?s=a but b was focused last. Persisted wins.
    const { state } = buildBootState({ persisted, urlSession: "a" });
    assert.strictEqual(state.focusedId, "b");
  });
});

describe("buildBootState — tab-set merge", () => {
  it("folds in tab-set sessions without focusing them", () => {
    const { state } = buildBootState({
      urlSession: "main",
      tabSetSessions: ["other"],
    });
    assert.ok(state.tiles.main);
    assert.ok(state.tiles.other);
    assert.strictEqual(state.focusedId, "main");
  });

  it("does not duplicate tab-set sessions that are already present", () => {
    const persisted = {
      version: 2,
      activeClusterId: "default",
      clusters: { default: { id: "default" } },
      tiles: {
        a: { id: "a", type: "terminal", props: {}, x: 0, clusterId: "default" },
      },
      focusedIdByCluster: { default: "a" },
      order: ["a"],
      focusedId: "a",
    };
    const { state } = buildBootState({ persisted, tabSetSessions: ["a"] });
    assert.strictEqual(Object.keys(state.tiles).length, 1);
  });
});

describe("buildBootState — pure function", () => {
  it("does not mutate inputs", () => {
    const persisted = {
      version: 2,
      activeClusterId: "default",
      clusters: { default: { id: "default" } },
      tiles: {
        a: { id: "a", type: "terminal", props: {}, x: 0, clusterId: "default" },
      },
      focusedIdByCluster: { default: "a" },
      order: ["a"],
      focusedId: "a",
    };
    const snapshot = JSON.parse(JSON.stringify(persisted));
    buildBootState({ persisted, urlSession: "b" });
    assert.deepStrictEqual(persisted, snapshot);
  });
});
