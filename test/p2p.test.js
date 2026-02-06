import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { destroyPeer } from "../lib/p2p.js";

describe("destroyPeer", () => {
  it("calls destroy() on the peer", () => {
    let called = false;
    const fakePeer = { destroy: () => { called = true; } };
    destroyPeer(fakePeer);
    assert.ok(called);
  });

  it("handles null gracefully", () => {
    assert.doesNotThrow(() => destroyPeer(null));
  });

  it("handles undefined gracefully", () => {
    assert.doesNotThrow(() => destroyPeer(undefined));
  });

  it("swallows errors from destroy()", () => {
    const fakePeer = { destroy: () => { throw new Error("already destroyed"); } };
    assert.doesNotThrow(() => destroyPeer(fakePeer));
  });
});
