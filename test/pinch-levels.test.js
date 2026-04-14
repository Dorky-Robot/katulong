import { describe, it } from "node:test";
import assert from "node:assert";

const {
  reducePinch,
  diffPinchState,
  PINCH_OUT_THRESHOLD,
  PINCH_IN_THRESHOLD,
  INITIAL_PINCH_STATE,
} = await import(
  new URL("../public/lib/pinch-levels.js", import.meta.url).href
);

describe("reducePinch — no-op zones", () => {
  it("returns same state when scale is inside the dead zone", () => {
    const s = { level: 1, mode: "carousel" };
    assert.strictEqual(reducePinch(s, { scale: 1.0 }), s);
    assert.strictEqual(reducePinch(s, { scale: 1.1 }), s);
    assert.strictEqual(reducePinch(s, { scale: 0.95 }), s);
  });

  it("accepts injected custom thresholds", () => {
    const s = { level: 1, mode: "carousel" };
    // Default thresholds would fire at 1.15/0.87 — custom won't.
    assert.strictEqual(reducePinch(s, { scale: 1.14 }), s);
    // Custom out=1.10 fires at 1.14.
    assert.deepStrictEqual(
      reducePinch(s, { scale: 1.14, out: 1.10 }),
      { level: 1, mode: "expose" },
    );
  });

  it("handles missing action object (defensive)", () => {
    const s = { level: 1, mode: "carousel" };
    assert.strictEqual(reducePinch(s, undefined), s);
  });
});

describe("reducePinch — pinch-out (zoom out)", () => {
  it("level 1 carousel → level 1 expose", () => {
    assert.deepStrictEqual(
      reducePinch({ level: 1, mode: "carousel" }, { scale: 1.15 }),
      { level: 1, mode: "expose" },
    );
  });

  it("level 1 expose → level 2 expose (uniform mode inherited)", () => {
    assert.deepStrictEqual(
      reducePinch({ level: 1, mode: "expose" }, { scale: 1.2 }),
      { level: 2, mode: "expose" },
    );
  });

  it("level 2 is the ceiling — pinch-out at level 2 no-ops", () => {
    const s = { level: 2, mode: "expose" };
    assert.strictEqual(reducePinch(s, { scale: 2.0 }), s);
  });

  it("fires exactly at the threshold", () => {
    assert.deepStrictEqual(
      reducePinch({ level: 1, mode: "carousel" }, { scale: PINCH_OUT_THRESHOLD }),
      { level: 1, mode: "expose" },
    );
  });
});

describe("reducePinch — pinch-in (zoom in)", () => {
  it("level 1 expose → level 1 carousel", () => {
    assert.deepStrictEqual(
      reducePinch({ level: 1, mode: "expose" }, { scale: 0.8 }),
      { level: 1, mode: "carousel" },
    );
  });

  it("level 1 carousel is the floor — pinch-in at level 1 carousel no-ops", () => {
    const s = { level: 1, mode: "carousel" };
    assert.strictEqual(reducePinch(s, { scale: 0.5 }), s);
  });

  it("level 2 expose → level 1 expose (keeps uniform mode)", () => {
    assert.deepStrictEqual(
      reducePinch({ level: 2, mode: "expose" }, { scale: 0.8 }),
      { level: 1, mode: "expose" },
    );
  });

  it("fires exactly at the threshold", () => {
    assert.deepStrictEqual(
      reducePinch({ level: 1, mode: "expose" }, { scale: PINCH_IN_THRESHOLD }),
      { level: 1, mode: "carousel" },
    );
  });
});

describe("reducePinch — round-trip", () => {
  it("carousel → expose → L2 → expose → carousel", () => {
    let s = INITIAL_PINCH_STATE;
    s = reducePinch(s, { scale: 1.2 });
    assert.deepStrictEqual(s, { level: 1, mode: "expose" });
    s = reducePinch(s, { scale: 1.2 });
    assert.deepStrictEqual(s, { level: 2, mode: "expose" });
    s = reducePinch(s, { scale: 0.8 });
    assert.deepStrictEqual(s, { level: 1, mode: "expose" });
    s = reducePinch(s, { scale: 0.8 });
    assert.deepStrictEqual(s, { level: 1, mode: "carousel" });
  });

  it("reducer is pure — doesn't mutate input", () => {
    const s = { level: 1, mode: "carousel" };
    const snap = JSON.parse(JSON.stringify(s));
    reducePinch(s, { scale: 1.5 });
    assert.deepStrictEqual(s, snap);
  });
});

describe("diffPinchState", () => {
  it("returns null when states are equal", () => {
    const s = { level: 1, mode: "carousel" };
    assert.strictEqual(diffPinchState(s, s), null);
    assert.strictEqual(
      diffPinchState({ level: 1, mode: "carousel" }, { level: 1, mode: "carousel" }),
      null,
    );
  });

  it("flags modeChanged when only mode differs", () => {
    assert.deepStrictEqual(
      diffPinchState({ level: 1, mode: "carousel" }, { level: 1, mode: "expose" }),
      { levelChanged: false, modeChanged: true },
    );
  });

  it("flags levelChanged when only level differs", () => {
    assert.deepStrictEqual(
      diffPinchState({ level: 1, mode: "expose" }, { level: 2, mode: "expose" }),
      { levelChanged: true, modeChanged: false },
    );
  });

  it("flags both when both differ", () => {
    assert.deepStrictEqual(
      diffPinchState({ level: 1, mode: "carousel" }, { level: 2, mode: "expose" }),
      { levelChanged: true, modeChanged: true },
    );
  });
});
