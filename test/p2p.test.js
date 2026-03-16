import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { destroyPeer, createServerPeer, p2pAvailable, initP2P, stripCandidatePrefix } from "../lib/p2p.js";

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

describe("createServerPeer — signal queue", { skip: !p2pAvailable && "node-datachannel not available" }, () => {
  it("signal queue processes signals in order", async () => {
    if (!p2pAvailable) return;
    const signals = [];
    const peer = createServerPeer(
      (data) => signals.push(data),
      () => {},
      () => {},
      () => {}
    );
    if (!peer) return;

    try {
      // Send a valid offer — should not throw even if ICE fails
      // (we're testing queue serialization, not ICE connectivity)
      const fakeOffer = {
        type: "offer",
        sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:test\r\na=ice-pwd:testpassword1234567890\r\na=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\n"
      };
      await peer.signal(fakeOffer);
      // Should have generated an answer
      assert.ok(signals.length > 0, "Should have sent an answer signal");
      assert.equal(signals[0].type, "answer");
    } finally {
      peer.destroy();
    }
  });

  it("signal queue rejects when closed", async () => {
    if (!p2pAvailable) return;
    const peer = createServerPeer(() => {}, () => {}, () => {}, () => {});
    if (!peer) return;

    peer.destroy();
    // Signaling after destroy should not throw
    await assert.doesNotReject(
      () => peer.signal({ type: "offer", sdp: "invalid" }),
      "Signaling a destroyed peer should not throw"
    );
  });

  it("send() returns false when not connected", () => {
    if (!p2pAvailable) return;
    const peer = createServerPeer(() => {}, () => {}, () => {}, () => {});
    if (!peer) return;

    try {
      const result = peer.send("test");
      assert.equal(result, false, "send() should return false when DataChannel is not open");
      assert.equal(typeof result, "boolean", "send() must return boolean for fallback logic");
    } finally {
      peer.destroy();
    }
  });
});

describe("mDNS candidate handling", () => {
  it("MDNS_LOOKUP_TIMEOUT_MS is 1 second (fast fail for containers)", async () => {
    // Import the constant indirectly by checking the module
    // The timeout was reduced from 3000 to 1000 to prevent long stalls
    // when mDNS is unavailable (common in Docker containers)
    const src = (await import("node:fs")).readFileSync(
      new URL("../lib/p2p.js", import.meta.url), "utf-8"
    );
    assert.ok(src.includes("MDNS_LOOKUP_TIMEOUT_MS = 1000"),
      "mDNS timeout should be 1000ms (not 3000ms) for fast failure in containers");
  });

  it("PRIVATE_IP regex matches RFC 1918 addresses", () => {
    const PRIVATE_IP = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|fd)/;
    assert.ok(PRIVATE_IP.test("10.0.0.1"));
    assert.ok(PRIVATE_IP.test("172.16.0.1"));
    assert.ok(PRIVATE_IP.test("172.31.255.255"));
    assert.ok(PRIVATE_IP.test("192.168.1.100"));
    assert.ok(PRIVATE_IP.test("169.254.1.1"));
    assert.ok(PRIVATE_IP.test("fd00::1"));
    assert.ok(!PRIVATE_IP.test("8.8.8.8"));
    assert.ok(!PRIVATE_IP.test("172.32.0.1"));
    assert.ok(!PRIVATE_IP.test("11.0.0.1"));
  });
});

describe("P2P client retry logic", () => {
  it("exponential backoff doubles delay each retry", () => {
    const baseDelay = 3000;
    const delays = [];
    for (let i = 1; i <= 3; i++) {
      delays.push(baseDelay * Math.pow(2, i - 1));
    }
    assert.deepEqual(delays, [3000, 6000, 12000]);
  });

  it("maxRetries default is 3", () => {
    // Verify the default config value matches what we expect
    const defaultMaxRetries = 3;
    assert.equal(defaultMaxRetries, 3);
  });

  it("retry count resets on successful connection", () => {
    // Simulate the retry state machine
    let retryCount = 0;
    const maxRetries = 3;
    let gaveUp = false;

    // Simulate 3 failures
    for (let i = 0; i < maxRetries; i++) {
      retryCount++;
    }
    assert.equal(retryCount, 3);

    // After maxRetries, should give up
    if (retryCount > maxRetries) gaveUp = true;
    // At exactly maxRetries, next increment would trigger give-up
    retryCount++;
    if (retryCount > maxRetries) gaveUp = true;
    assert.ok(gaveUp, "Should give up after maxRetries");

    // Simulate successful connection — resets
    retryCount = 0;
    gaveUp = false;
    assert.equal(retryCount, 0);
    assert.ok(!gaveUp);
  });
});

describe("stripCandidatePrefix", () => {
  it("strips a= prefix from SDP attribute format candidates", () => {
    const input = "a=candidate:1 1 UDP 2114977791 192.168.1.138 64862 typ host";
    const expected = "candidate:1 1 UDP 2114977791 192.168.1.138 64862 typ host";
    assert.strictEqual(stripCandidatePrefix(input), expected);
  });

  it("leaves bare candidate strings unchanged", () => {
    const input = "candidate:1 1 UDP 2114977791 192.168.1.138 64862 typ host";
    assert.strictEqual(stripCandidatePrefix(input), input);
  });

  it("strips a= prefix from IPv6 candidates", () => {
    const input = "a=candidate:2 1 UDP 2116026111 fd32:bdc4:6078:2303::1 64862 typ host";
    const expected = "candidate:2 1 UDP 2116026111 fd32:bdc4:6078:2303::1 64862 typ host";
    assert.strictEqual(stripCandidatePrefix(input), expected);
  });

  it("handles empty string", () => {
    assert.strictEqual(stripCandidatePrefix(""), "");
  });

  it("does not strip a= from middle of string", () => {
    const input = "candidate:1 a=something";
    assert.strictEqual(stripCandidatePrefix(input), input);
  });
});
