import { describe, it } from "node:test";
import assert from "node:assert";

const {
  decideAddTarget,
  generateSessionName,
  generateClusterId,
  createAddHandler,
} = await import(
  new URL("../public/lib/add-target.js", import.meta.url).href
);

describe("decideAddTarget — level 1 (focused)", () => {
  it("produces a tile target in the active cluster after the focused tile", () => {
    const t = decideAddTarget({ level: 1, activeClusterId: "c1", focusedId: "t7" });
    assert.deepStrictEqual(t, { kind: "tile", clusterId: "c1", insertAfter: "t7" });
  });

  it("produces a tile target with insertAfter=null when nothing is focused", () => {
    const t = decideAddTarget({ level: 1, activeClusterId: "c1", focusedId: null });
    assert.deepStrictEqual(t, { kind: "tile", clusterId: "c1", insertAfter: null });
  });

  it("defaults focusedId to null when omitted", () => {
    const t = decideAddTarget({ level: 1, activeClusterId: "c1" });
    assert.strictEqual(t.insertAfter, null);
  });
});

describe("decideAddTarget — level 2 (overview)", () => {
  it("produces a cluster target regardless of focused tile", () => {
    assert.deepStrictEqual(
      decideAddTarget({ level: 2, activeClusterId: "c1", focusedId: "t7" }),
      { kind: "cluster" },
    );
    assert.deepStrictEqual(
      decideAddTarget({ level: 2, activeClusterId: "c1", focusedId: null }),
      { kind: "cluster" },
    );
  });

  it("treats future Level 3+ as cluster target (safe default until L3 is designed)", () => {
    assert.deepStrictEqual(
      decideAddTarget({ level: 3, activeClusterId: "c1" }),
      { kind: "cluster" },
    );
  });
});

describe("generateSessionName / generateClusterId", () => {
  it("produces a `session-` prefix with base36-encoded clock", () => {
    const name = generateSessionName(() => 0);
    assert.strictEqual(name, "session-0");
  });

  it("produces a `cluster-` prefix with base36-encoded clock", () => {
    const id = generateClusterId(() => 0);
    assert.strictEqual(id, "cluster-0");
  });

  it("defaults to Date.now when no clock is injected", () => {
    const name = generateSessionName();
    assert.match(name, /^session-[a-z0-9]+$/);
  });
});

describe("createAddHandler — dispatch", () => {
  it("calls onAddTile with the tile target at level 1", () => {
    const calls = [];
    const handle = createAddHandler({
      getLevel: () => 1,
      getState: () => ({ activeClusterId: "c1", focusedId: "t7" }),
      onAddTile: (t) => { calls.push(["tile", t]); },
      onAddCluster: (t) => { calls.push(["cluster", t]); },
    });
    handle();
    assert.deepStrictEqual(calls, [
      ["tile", { kind: "tile", clusterId: "c1", insertAfter: "t7" }],
    ]);
  });

  it("calls onAddCluster with the cluster target at level 2", () => {
    const calls = [];
    const handle = createAddHandler({
      getLevel: () => 2,
      getState: () => ({ activeClusterId: "c1", focusedId: "t7" }),
      onAddTile: (t) => { calls.push(["tile", t]); },
      onAddCluster: (t) => { calls.push(["cluster", t]); },
    });
    handle();
    assert.deepStrictEqual(calls, [["cluster", { kind: "cluster" }]]);
  });

  it("reads fresh state at every call, not at factory creation time", () => {
    let level = 1;
    let focusedId = "t1";
    const tileCalls = [];
    const clusterCalls = [];
    const handle = createAddHandler({
      getLevel: () => level,
      getState: () => ({ activeClusterId: "c1", focusedId }),
      onAddTile: (t) => { tileCalls.push(t); },
      onAddCluster: (t) => { clusterCalls.push(t); },
    });
    handle();
    focusedId = "t2";
    handle();
    level = 2;
    handle();
    assert.strictEqual(tileCalls.length, 2);
    assert.strictEqual(tileCalls[0].insertAfter, "t1");
    assert.strictEqual(tileCalls[1].insertAfter, "t2");
    assert.strictEqual(clusterCalls.length, 1);
  });

  it("returns the effect's return value (so async callers can await)", async () => {
    const handle = createAddHandler({
      getLevel: () => 1,
      getState: () => ({ activeClusterId: "c1", focusedId: null }),
      onAddTile: async () => "tile-result",
      onAddCluster: async () => "cluster-result",
    });
    assert.strictEqual(await handle(), "tile-result");
  });
});
