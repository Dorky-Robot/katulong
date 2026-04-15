/**
 * pinch-gesture — unified touch + trackpad pinch detector.
 *
 * These tests drive the (scale, phase) stream by feeding synthetic
 * PointerEvents (touch path) and wheel events with ctrlKey=true
 * (trackpad path). The module has zero framework dependencies, so a
 * small fake target with addEventListener/removeEventListener is enough.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

const { createPinchGesture } = await import(
  new URL("../public/lib/pinch-gesture.js", import.meta.url).href
);

function createFakeTarget() {
  const listeners = {};
  return {
    _listeners: listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(f => f !== fn);
    },
    fire(type, ev) {
      (listeners[type] || []).forEach(fn => fn(ev));
    },
  };
}

function wheelEvent(deltaY) {
  return {
    ctrlKey: true,
    deltaY,
    preventDefault() { this._prevented = true; },
  };
}

function pointerEvent(type, id, x, y) {
  return {
    pointerType: type,
    pointerId: id,
    clientX: x,
    clientY: y,
    preventDefault() { this._prevented = true; },
  };
}

describe("pinch-gesture — constructor guards", () => {
  it("throws without a target", () => {
    assert.throws(
      () => createPinchGesture({ onPinch: () => {} }),
      /target and onPinch required/,
    );
  });
  it("throws without onPinch", () => {
    assert.throws(
      () => createPinchGesture({ target: createFakeTarget() }),
      /target and onPinch required/,
    );
  });
});

describe("pinch-gesture — wheel (trackpad) path", () => {
  let target, events, gesture;
  beforeEach(() => {
    target = createFakeTarget();
    events = [];
    gesture = createPinchGesture({
      target,
      onPinch: (e) => events.push({ phase: e.phase, scale: Number(e.scale.toFixed(4)) }),
    });
    gesture.attach();
  });

  it("ignores non-ctrl wheel events (ordinary scroll)", () => {
    target.fire("wheel", { ctrlKey: false, deltaY: 50, preventDefault() {} });
    assert.strictEqual(events.length, 0);
  });

  it("emits start + move on first ctrl+wheel", () => {
    target.fire("wheel", wheelEvent(-10));
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].phase, "start");
    assert.strictEqual(events[0].scale, 1);
    assert.strictEqual(events[1].phase, "move");
    assert.ok(events[1].scale > 1, "pinch out produces scale > 1");
  });

  it("negative deltaY zooms in (scale > 1) and positive zooms out", () => {
    target.fire("wheel", wheelEvent(-10));
    const scaleOut = events[events.length - 1].scale;
    assert.ok(scaleOut > 1);

    events.length = 0;
    target = createFakeTarget();
    const e2 = [];
    const g2 = createPinchGesture({ target, onPinch: (e) => e2.push(e) });
    g2.attach();
    target.fire("wheel", wheelEvent(10));
    const scaleIn = e2[e2.length - 1].scale;
    assert.ok(scaleIn < 1);
  });

  it("clamps scale to a sane range mid-gesture", () => {
    // Huge negative delta should not blow up past ~5
    target.fire("wheel", wheelEvent(-1000));
    const last = events[events.length - 1].scale;
    assert.ok(last <= 5, `expected scale<=5, got ${last}`);
  });

  it("detaches and stops responding to events", () => {
    gesture.detach();
    target.fire("wheel", wheelEvent(-10));
    assert.strictEqual(events.length, 0);
  });
});

describe("pinch-gesture — touch (two-pointer) path", () => {
  let target, events, gesture;
  beforeEach(() => {
    target = createFakeTarget();
    events = [];
    gesture = createPinchGesture({
      target,
      onPinch: (e) => events.push({ phase: e.phase, scale: Number(e.scale.toFixed(4)) }),
    });
    gesture.attach();
  });

  it("ignores mouse pointers (trackpad pinch goes through wheel path)", () => {
    target.fire("pointerdown", pointerEvent("mouse", 1, 0, 0));
    target.fire("pointerdown", pointerEvent("mouse", 2, 100, 0));
    target.fire("pointermove", pointerEvent("mouse", 1, -50, 0));
    assert.strictEqual(events.length, 0);
  });

  it("emits start + move once two fingers scale past the activation threshold", () => {
    target.fire("pointerdown", pointerEvent("touch", 1, 0, 0));
    target.fire("pointerdown", pointerEvent("touch", 2, 100, 0));
    // Tiny move below MIN_ACTIVATION should not fire.
    target.fire("pointermove", pointerEvent("touch", 2, 101, 0));
    assert.strictEqual(events.length, 0);

    // Push second finger out so distance goes 100 → 200 (scale 2).
    target.fire("pointermove", pointerEvent("touch", 2, 200, 0));
    assert.ok(events.length >= 2);
    assert.strictEqual(events[0].phase, "start");
    assert.strictEqual(events[0].scale, 1);
    assert.strictEqual(events[1].phase, "move");
    assert.strictEqual(events[1].scale, 2);
  });

  it("fires end with the final scale when a finger lifts", () => {
    target.fire("pointerdown", pointerEvent("touch", 1, 0, 0));
    target.fire("pointerdown", pointerEvent("touch", 2, 100, 0));
    target.fire("pointermove", pointerEvent("touch", 2, 200, 0));
    events.length = 0;
    target.fire("pointerup", pointerEvent("touch", 2, 200, 0));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].phase, "end");
    assert.strictEqual(events[0].scale, 2);
  });

  it("does not fire end if activation was never reached", () => {
    target.fire("pointerdown", pointerEvent("touch", 1, 0, 0));
    target.fire("pointerdown", pointerEvent("touch", 2, 100, 0));
    target.fire("pointerup", pointerEvent("touch", 2, 100, 0));
    assert.strictEqual(events.length, 0);
  });
});
