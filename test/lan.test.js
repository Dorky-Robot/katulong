import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLanAddresses } from "../lib/lan.js";

describe("getLanAddresses", () => {
  it("returns an array", () => {
    const result = getLanAddresses();
    assert.ok(Array.isArray(result), "should return an array");
  });

  it("contains only strings", () => {
    const result = getLanAddresses();
    for (const addr of result) {
      assert.strictEqual(typeof addr, "string", `expected string, got ${typeof addr}`);
    }
  });

  it("excludes 127.0.0.1 (internal/loopback)", () => {
    const result = getLanAddresses();
    assert.ok(!result.includes("127.0.0.1"), "should not include loopback address");
  });

  it("contains only valid IPv4 addresses", () => {
    const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    const result = getLanAddresses();
    for (const addr of result) {
      assert.ok(ipv4Pattern.test(addr), `${addr} is not a valid IPv4 address`);
    }
  });

  it("returns at least one address on a machine with a network interface", () => {
    // Most CI/dev machines have at least one non-internal IPv4 address
    const result = getLanAddresses();
    assert.ok(result.length >= 1, "expected at least one LAN address");
  });
});
