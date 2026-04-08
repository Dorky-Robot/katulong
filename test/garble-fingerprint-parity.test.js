/**
 * Tests for client/server screen fingerprint parity.
 *
 * Why this exists:
 * Drift detection works by computing a screen hash on the server and
 * comparing it to a hash the client computes from its own xterm.js
 * terminal. The two hashes only agree if the two implementations
 * (`lib/session.js screenFingerprint()` and `public/lib/screen-fingerprint.js
 * screenFingerprint()`) read EXACTLY the same fields in EXACTLY the same
 * order through EXACTLY the same DJB2 algorithm.
 *
 * The two existing tests (`garble-fingerprint-dims.test.js`) cover:
 *   1. The CLIENT function in isolation, against a mock terminal
 *   2. The CLIENT function against a manual DJB2 calculation
 *
 * Neither catches the failure mode where the SERVER algorithm drifts from
 * the client (or vice versa) — for example, if someone adds bg color to
 * the hash on one side but not the other. That kind of drift produces
 * silent garble symptoms in production: every state-check reports
 * mismatch, every mismatch triggers a resync, every resync nukes the
 * screen, repeat forever.
 *
 * This test pins parity directly: the same `_headless` xterm.js Terminal
 * goes through BOTH implementations and the hashes must agree byte-for-byte.
 * If a future change breaks parity, this test fails immediately and points
 * at the divergent file.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../lib/session.js";
import { screenFingerprint as clientFingerprint } from "../public/lib/screen-fingerprint.js";

/**
 * Build a Session and write some content into its `_headless` so the
 * buffer has a non-trivial, deterministic state to fingerprint.
 *
 * The session is NOT attached to a real tmux process — it's only used as
 * a host for the headless xterm and to expose `screenFingerprint()`. The
 * `outputBuffer` is plumbed through so the returned `seq` field has a
 * sensible value, but tests here only assert on `hash` parity.
 */
async function makeFingerprintableSession(content) {
  const session = new Session("parity", "parity");
  // Write directly to the headless terminal (bypassing tmux protocol).
  // We need an explicit await on the xterm write callback because the
  // server's screenFingerprint() uses the same flush-then-read pattern.
  await new Promise(resolve => session._headless.write(content, resolve));
  return session;
}

describe("client/server screenFingerprint parity", () => {
  it("hashes match for an empty terminal", async () => {
    const session = await makeFingerprintableSession("");
    const server = await session.screenFingerprint();
    const client = clientFingerprint(session._headless);
    assert.strictEqual(server.hash, client,
      "empty terminal must produce identical hashes on both sides — " +
      "if this fails, the dimensions or cursor encoding differ between " +
      "lib/session.js and public/lib/screen-fingerprint.js");
  });

  it("hashes match after writing plain ASCII", async () => {
    const session = await makeFingerprintableSession("hello world\r\n");
    const server = await session.screenFingerprint();
    const client = clientFingerprint(session._headless);
    assert.strictEqual(server.hash, client,
      "ASCII content must produce identical hashes — divergence here " +
      "means one side is reading characters or rows differently");
  });

  it("hashes match after writing multiple lines", async () => {
    const session = await makeFingerprintableSession(
      "line1\r\nline2\r\nline3\r\n"
    );
    const server = await session.screenFingerprint();
    const client = clientFingerprint(session._headless);
    assert.strictEqual(server.hash, client);
  });

  it("hashes match after writing UTF-8 multi-byte content", async () => {
    // Mix of BMP (你好) and supplementary plane (👋) characters — these
    // exercise xterm's UTF-16 surrogate handling, which is the most likely
    // place client and server to diverge if `translateToString(true)` is
    // ever swapped for a different encoding helper.
    const session = await makeFingerprintableSession("你好 👋 world\r\n");
    const server = await session.screenFingerprint();
    const client = clientFingerprint(session._headless);
    assert.strictEqual(server.hash, client,
      "UTF-8 multi-byte parity is the most failure-prone case — both " +
      "sides must produce the same UTF-16 code units in the same order");
  });

  it("hashes match after cursor movement (CUP escape)", async () => {
    // CSI 5;10 H positions the cursor at row 5, col 10. Both implementations
    // hash cursorY then cursorX — if the order ever swaps, this test catches it.
    const session = await makeFingerprintableSession("\x1b[5;10H");
    const server = await session.screenFingerprint();
    const client = clientFingerprint(session._headless);
    assert.strictEqual(server.hash, client,
      "cursor position parity — if this fails the cursorY/cursorX hash " +
      "order differs between client and server");
  });

  it("hashes match after a resize (different cols/rows)", async () => {
    // Dimensions are part of the hash so a resize must be reflected on
    // both sides. The session resizes its `_headless` directly via
    // `_applyResize`, but here we just call `_headless.resize` to skip
    // the tmux side-effects.
    const session = await makeFingerprintableSession("padded text\r\n");
    session._headless.resize(120, 30);
    // Flush the resize through xterm's internal queue.
    await new Promise(resolve => session._headless.write("", resolve));
    const server = await session.screenFingerprint();
    const client = clientFingerprint(session._headless);
    assert.strictEqual(server.hash, client,
      "resize parity — both implementations must read the new cols/rows " +
      "from the same terminal field after resize takes effect");
  });

  it("hashes change when content changes (sanity check)", async () => {
    // Cross-check: if both implementations always returned 0, the parity
    // tests above would pass but be useless. Verify the hash is sensitive
    // to actual content changes on both sides.
    const sessionA = await makeFingerprintableSession("alpha\r\n");
    const sessionB = await makeFingerprintableSession("beta\r\n");
    const fpA = await sessionA.screenFingerprint();
    const fpB = await sessionB.screenFingerprint();
    assert.notStrictEqual(fpA.hash, fpB.hash,
      "different content must produce different hashes — if this fails " +
      "the algorithm is broken on the server side");
    const clientA = clientFingerprint(sessionA._headless);
    const clientB = clientFingerprint(sessionB._headless);
    assert.notStrictEqual(clientA, clientB,
      "different content must produce different hashes — if this fails " +
      "the algorithm is broken on the client side");
  });
});
