import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeIndicatorState } from "../public/lib/connection-indicator.js";

describe("computeIndicatorState", () => {
  describe("disconnected", () => {
    it("returns grey (no class) and 'Disconnected' title when not attached", () => {
      const result = computeIndicatorState(false, null);
      assert.equal(result.cssClass, "");
      assert.equal(result.title, "Disconnected");
    });
  });

  describe("attached + websocket", () => {
    it("returns relay class and 'Relay (WebSocket)' title", () => {
      const result = computeIndicatorState(true, "websocket");
      assert.equal(result.cssClass, "relay");
      assert.equal(result.title, "Relay (WebSocket)");
    });
  });

  describe("attached + datachannel", () => {
    it("returns direct class and 'Direct (P2P)' title", () => {
      const result = computeIndicatorState(true, "datachannel");
      assert.equal(result.cssClass, "direct");
      assert.equal(result.title, "Direct (P2P)");
    });
  });

  describe("defaults to relay when transportType is missing", () => {
    it("returns relay when transportType is null", () => {
      const result = computeIndicatorState(true, null);
      assert.equal(result.cssClass, "relay");
      assert.equal(result.title, "Relay (WebSocket)");
    });

    it("returns relay when transportType is undefined", () => {
      const result = computeIndicatorState(true, undefined);
      assert.equal(result.cssClass, "relay");
      assert.equal(result.title, "Relay (WebSocket)");
    });
  });

  describe("state transitions", () => {
    it("transitions correctly: disconnected → relay → direct → disconnected", () => {
      // Start disconnected
      let result = computeIndicatorState(false, null);
      assert.equal(result.cssClass, "");
      assert.equal(result.title, "Disconnected");

      // Connect via WebSocket relay
      result = computeIndicatorState(true, "websocket");
      assert.equal(result.cssClass, "relay");
      assert.equal(result.title, "Relay (WebSocket)");

      // Upgrade to P2P datachannel
      result = computeIndicatorState(true, "datachannel");
      assert.equal(result.cssClass, "direct");
      assert.equal(result.title, "Direct (P2P)");

      // Disconnect
      result = computeIndicatorState(false, null);
      assert.equal(result.cssClass, "");
      assert.equal(result.title, "Disconnected");
    });
  });

  describe("no stale classes", () => {
    it("returns distinct cssClass values for each state (no overlap)", () => {
      const disconnected = computeIndicatorState(false, null);
      const relay = computeIndicatorState(true, "websocket");
      const direct = computeIndicatorState(true, "datachannel");

      // All three states produce different cssClass values
      const classes = [disconnected.cssClass, relay.cssClass, direct.cssClass];
      assert.equal(new Set(classes).size, 3, "each state must have a unique cssClass");

      // Empty string for disconnected ensures no stale class remains
      assert.equal(disconnected.cssClass, "");
      // relay and direct are non-empty and different
      assert.notEqual(relay.cssClass, direct.cssClass);
    });
  });
});
