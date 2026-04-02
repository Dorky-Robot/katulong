import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createWebRTCSignaling } from "../lib/webrtc-signaling.js";

/**
 * Mock RTCPeerConnection for testing signaling without node-datachannel.
 *
 * Simulates the browser/node RTCPeerConnection API surface used by the
 * signaling module: setRemoteDescription, createAnswer, setLocalDescription,
 * addIceCandidate, close, and the ondatachannel / onicecandidate callbacks.
 */
class MockRTCPeerConnection {
  constructor() {
    this.localDescription = null;
    this.remoteDescription = null;
    this.candidates = [];
    this.ondatachannel = null;
    this.onicecandidate = null;
    this.closed = false;
  }
  async setRemoteDescription(desc) { this.remoteDescription = desc; }
  async setLocalDescription(desc) { this.localDescription = desc; }
  async createAnswer() { return { type: "answer", sdp: "mock-answer-sdp" }; }
  addIceCandidate(c) { this.candidates.push(c); }
  close() { this.closed = true; }
}

/**
 * Create a signaling instance with standard test scaffolding.
 * Returns the signaling API plus arrays that collect onDataChannel
 * and onSend calls for assertions.
 */
function setup(opts = {}) {
  const dataChannels = [];
  const sentMessages = [];
  const PeerConnection = opts.PeerConnection || MockRTCPeerConnection;

  const signaling = createWebRTCSignaling({
    onDataChannel: (clientId, dc) => dataChannels.push({ clientId, dc }),
    onSend: (clientId, msg) => sentMessages.push({ clientId, msg }),
    RTCPeerConnection: PeerConnection,
  });

  return { signaling, dataChannels, sentMessages };
}

describe("createWebRTCSignaling", () => {
  describe("handleOffer", () => {
    it("creates a peer connection for the client", async () => {
      const { signaling } = setup();
      await signaling.handleOffer("client-1", { type: "offer", sdp: "test-sdp" });
      // A second offer for a different client should also work
      await signaling.handleOffer("client-2", { type: "offer", sdp: "test-sdp-2" });
      // Both should have independent connections (verified via disconnect)
      signaling.handleDisconnect("client-1");
      // client-2 should still accept candidates (not cleaned up)
      await signaling.handleCandidate("client-2", { candidate: "c" });
    });

    it("sets remote description from the offer SDP", async () => {
      let captured = null;
      class CapturePeerConnection extends MockRTCPeerConnection {
        async setRemoteDescription(desc) {
          captured = desc;
          await super.setRemoteDescription(desc);
        }
      }

      const { signaling } = setup({ PeerConnection: CapturePeerConnection });
      const offer = { type: "offer", sdp: "remote-sdp-value" };
      await signaling.handleOffer("client-1", offer);

      assert.deepEqual(captured, offer);
    });

    it("creates and sends an answer back via onSend", async () => {
      const { signaling, sentMessages } = setup();
      await signaling.handleOffer("client-1", { type: "offer", sdp: "o" });

      // Should have sent an rtc-answer message
      const answers = sentMessages.filter((m) => m.msg.type === "rtc-answer");
      assert.equal(answers.length, 1);
      assert.equal(answers[0].clientId, "client-1");
      assert.equal(answers[0].msg.sdp, "mock-answer-sdp");
    });

    it("calls setLocalDescription with the created answer", async () => {
      let localDesc = null;
      class CapturePeerConnection extends MockRTCPeerConnection {
        async setLocalDescription(desc) {
          localDesc = desc;
          await super.setLocalDescription(desc);
        }
      }

      const { signaling } = setup({ PeerConnection: CapturePeerConnection });
      await signaling.handleOffer("client-1", { type: "offer", sdp: "o" });

      assert.ok(localDesc, "setLocalDescription should have been called");
      assert.equal(localDesc.type, "answer");
      assert.equal(localDesc.sdp, "mock-answer-sdp");
    });

    it("replaces an existing peer connection on re-offer (ICE restart)", async () => {
      let createCount = 0;
      class CountingPeerConnection extends MockRTCPeerConnection {
        constructor() {
          super();
          createCount++;
        }
      }

      const { signaling } = setup({ PeerConnection: CountingPeerConnection });
      await signaling.handleOffer("client-1", { type: "offer", sdp: "first" });
      await signaling.handleOffer("client-1", { type: "offer", sdp: "second" });

      // Two PeerConnections should have been created (old one closed)
      assert.equal(createCount, 2);
    });
  });

  describe("handleCandidate", () => {
    it("adds ICE candidate to the peer connection", async () => {
      let addedCandidates = [];
      class CapturePeerConnection extends MockRTCPeerConnection {
        addIceCandidate(c) {
          addedCandidates.push(c);
          super.addIceCandidate(c);
        }
      }

      const { signaling } = setup({ PeerConnection: CapturePeerConnection });
      await signaling.handleOffer("client-1", { type: "offer", sdp: "o" });
      await signaling.handleCandidate("client-1", { candidate: "ice-1", sdpMid: "0" });

      assert.equal(addedCandidates.length, 1);
      assert.deepEqual(addedCandidates[0], { candidate: "ice-1", sdpMid: "0" });
    });

    it("ignores candidates for unknown clients (no throw)", async () => {
      const { signaling } = setup();
      // Should not throw even though no offer was made for this client
      await assert.doesNotReject(
        () => signaling.handleCandidate("unknown-client", { candidate: "c" }),
      );
    });
  });

  describe("handleDisconnect", () => {
    it("cleans up (closes) the peer connection", async () => {
      let closedCount = 0;
      class TrackClosePeerConnection extends MockRTCPeerConnection {
        close() {
          closedCount++;
          super.close();
        }
      }

      const { signaling } = setup({ PeerConnection: TrackClosePeerConnection });
      await signaling.handleOffer("client-1", { type: "offer", sdp: "o" });
      signaling.handleDisconnect("client-1");

      assert.equal(closedCount, 1);
    });

    it("is idempotent (calling twice does not throw)", async () => {
      const { signaling } = setup();
      await signaling.handleOffer("client-1", { type: "offer", sdp: "o" });

      assert.doesNotThrow(() => signaling.handleDisconnect("client-1"));
      assert.doesNotThrow(() => signaling.handleDisconnect("client-1"));
    });

    it("does not throw for unknown clients", () => {
      const { signaling } = setup();
      assert.doesNotThrow(() => signaling.handleDisconnect("never-existed"));
    });
  });

  describe("onDataChannel callback", () => {
    it("fires when ondatachannel event occurs on the peer connection", async () => {
      const { signaling, dataChannels } = setup();
      await signaling.handleOffer("client-1", { type: "offer", sdp: "o" });

      // Simulate the RTCPeerConnection firing ondatachannel.
      // The signaling module must have set pc.ondatachannel during handleOffer.
      // We reach into the mock to trigger it — the module exposes no other way.
      // This verifies the module actually wires up the callback.
      const fakeChannel = { label: "data", readyState: "open" };
      const pc = signaling._getPeerConnection("client-1");
      assert.ok(pc, "peer connection should exist after handleOffer");
      assert.ok(pc.ondatachannel, "ondatachannel should be wired up");
      pc.ondatachannel({ channel: fakeChannel });

      assert.equal(dataChannels.length, 1);
      assert.equal(dataChannels[0].clientId, "client-1");
      assert.equal(dataChannels[0].dc, fakeChannel);
    });
  });

  describe("ICE candidate from server", () => {
    it("sends server ICE candidates via onSend", async () => {
      const { signaling, sentMessages } = setup();
      await signaling.handleOffer("client-1", { type: "offer", sdp: "o" });

      // Simulate the RTCPeerConnection generating a local ICE candidate
      const pc = signaling._getPeerConnection("client-1");
      assert.ok(pc.onicecandidate, "onicecandidate should be wired up");
      pc.onicecandidate({ candidate: { candidate: "server-ice", sdpMid: "0" } });

      const iceMsgs = sentMessages.filter((m) => m.msg.type === "rtc-ice-candidate");
      assert.equal(iceMsgs.length, 1);
      assert.equal(iceMsgs[0].clientId, "client-1");
      assert.deepEqual(iceMsgs[0].msg.candidate, { candidate: "server-ice", sdpMid: "0" });
    });

    it("ignores null candidate events (end-of-candidates signal)", async () => {
      const { signaling, sentMessages } = setup();
      await signaling.handleOffer("client-1", { type: "offer", sdp: "o" });

      const pc = signaling._getPeerConnection("client-1");
      // null candidate means end-of-candidates — should not send a message
      pc.onicecandidate({ candidate: null });

      const iceMsgs = sentMessages.filter((m) => m.msg.type === "rtc-ice-candidate");
      assert.equal(iceMsgs.length, 0);
    });
  });

  describe("error handling", () => {
    it("errors in peer connection creation do not crash", async () => {
      class BrokenPeerConnection {
        constructor() { throw new Error("WebRTC not available"); }
      }

      const { signaling, sentMessages } = setup({ PeerConnection: BrokenPeerConnection });

      // Should not reject — errors are caught internally
      await assert.doesNotReject(
        () => signaling.handleOffer("client-1", { type: "offer", sdp: "o" }),
      );

      // No answer should have been sent
      const answers = sentMessages.filter((m) => m.msg.type === "rtc-answer");
      assert.equal(answers.length, 0);
    });

    it("errors in setRemoteDescription do not crash", async () => {
      class FailRemotePeerConnection extends MockRTCPeerConnection {
        async setRemoteDescription() { throw new Error("invalid SDP"); }
      }

      const { signaling } = setup({ PeerConnection: FailRemotePeerConnection });

      await assert.doesNotReject(
        () => signaling.handleOffer("client-1", { type: "offer", sdp: "bad" }),
      );
    });

    it("errors in addIceCandidate do not crash", async () => {
      class FailCandidatePeerConnection extends MockRTCPeerConnection {
        addIceCandidate() { throw new Error("bad candidate"); }
      }

      const { signaling } = setup({ PeerConnection: FailCandidatePeerConnection });
      await signaling.handleOffer("client-1", { type: "offer", sdp: "o" });

      await assert.doesNotReject(
        () => signaling.handleCandidate("client-1", { candidate: "bad" }),
      );
    });
  });
});
