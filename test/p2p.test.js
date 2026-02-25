import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { destroyPeer, createServerPeer, p2pAvailable, initP2P } from "../lib/p2p.js";

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

describe("initP2P", () => {
  it("sets p2pAvailable flag (true if node-datachannel loads, false otherwise)", async () => {
    // initP2P has already been called or we call it — it should not throw regardless
    await assert.doesNotReject(() => initP2P(), "initP2P should not throw even if node-datachannel is unavailable");
    // p2pAvailable is either true or false depending on environment
    assert.strictEqual(typeof p2pAvailable, "boolean", "p2pAvailable should be a boolean");
  });
});

describe("createServerPeer", () => {
  it("returns null when p2pAvailable is false and node-datachannel is not loaded", () => {
    // In test environments without node-datachannel, p2pAvailable is false
    if (!p2pAvailable) {
      const peer = createServerPeer(() => {}, () => {}, () => {});
      assert.strictEqual(peer, null, "should return null when P2P is not available");
    }
  });

  it("accepts callback arguments without throwing", () => {
    // Whether or not P2P is available, calling with proper callbacks should not throw
    assert.doesNotThrow(() => {
      const result = createServerPeer(() => {}, () => {}, () => {});
      // If P2P is unavailable, result is null — destroy for cleanup if not null
      if (result) {
        try { result.destroy(); } catch {}
      }
    });
  });
});
