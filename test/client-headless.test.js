import { describe, it } from "node:test";
import assert from "node:assert";
import { ClientHeadless } from "../lib/client-headless.js";
import { RingBuffer } from "../lib/ring-buffer.js";

describe("ClientHeadless", () => {
  describe("constructor", () => {
    it("creates instance with default scrollback", () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);
      assert.strictEqual(ch.cols, 80);
      assert.strictEqual(ch.rows, 24);
      ch.dispose();
    });

    it("creates instance with custom scrollback", () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24, 100);
      assert.strictEqual(ch.cols, 80);
      assert.strictEqual(ch.rows, 24);
      ch.dispose();
    });
  });

  describe("replay", () => {
    it("replays data pushed to RingBuffer", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      rb.push("Hello World");
      const result = ch.replay();
      assert.deepStrictEqual(result, { ok: true });

      const screen = await ch.serializeScreen();
      assert.ok(screen.includes("Hello World"), `expected screen to contain "Hello World", got: ${screen}`);
      ch.dispose();
    });

    it("is idempotent — replaying twice yields same result", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      rb.push("Hello");
      ch.replay();
      const screen1 = await ch.serializeScreen();

      // Replay again with no new data
      const result = ch.replay();
      assert.deepStrictEqual(result, { ok: true });
      const screen2 = await ch.serializeScreen();

      assert.strictEqual(screen1, screen2);
      ch.dispose();
    });

    it("replays incrementally after more data is pushed", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      rb.push("First");
      ch.replay();
      const screen1 = await ch.serializeScreen();
      assert.ok(screen1.includes("First"));

      rb.push(" Second");
      ch.replay();
      const screen2 = await ch.serializeScreen();
      assert.ok(screen2.includes("First"));
      assert.ok(screen2.includes("Second"), `expected screen to contain "Second", got: ${screen2}`);
      ch.dispose();
    });

    it("detects eviction past replay cursor", () => {
      // RingBuffer with very small capacity so data gets evicted
      const rb = new RingBuffer(20);
      const ch = new ClientHeadless(rb, 80, 24);

      // Push some data and don't replay
      rb.push("aaaaaaaaaa"); // 10 bytes

      // Push more data to evict the first chunk
      rb.push("bbbbbbbbbbbb"); // 12 bytes, total 22 -> evicts "aaaaaaaaaa"
      rb.push("cccccccccccc"); // 12 bytes, total 24 -> evicts "bbbbbbbbbbbb"

      // Now replay — cursor is at 0 but startOffset is past that
      const result = ch.replay();
      assert.deepStrictEqual(result, { evicted: true });
      ch.dispose();
    });

    it("returns ok when RingBuffer is empty", () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      const result = ch.replay();
      assert.deepStrictEqual(result, { ok: true });
      ch.dispose();
    });
  });

  describe("serializeScreen", () => {
    it("calls replay before serializing", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      rb.push("auto-replay");
      // serializeScreen should call replay internally
      const screen = await ch.serializeScreen();
      assert.ok(screen.includes("auto-replay"), `expected "auto-replay" in screen: ${screen}`);
      ch.dispose();
    });

    it("returns empty-ish output for fresh terminal", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      const screen = await ch.serializeScreen();
      // A fresh terminal serializes to something (possibly empty or whitespace)
      assert.strictEqual(typeof screen, "string");
      ch.dispose();
    });
  });

  describe("screenFingerprint", () => {
    it("returns a number", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      rb.push("Hello");
      const fp = await ch.screenFingerprint();
      assert.strictEqual(typeof fp, "number");
      ch.dispose();
    });

    it("differs for different content", async () => {
      const rb1 = new RingBuffer();
      const ch1 = new ClientHeadless(rb1, 80, 24);
      rb1.push("Hello");
      const fp1 = await ch1.screenFingerprint();

      const rb2 = new RingBuffer();
      const ch2 = new ClientHeadless(rb2, 80, 24);
      rb2.push("World");
      const fp2 = await ch2.screenFingerprint();

      assert.notStrictEqual(fp1, fp2);
      ch1.dispose();
      ch2.dispose();
    });

    it("differs for different dimensions with same content", async () => {
      const rb1 = new RingBuffer();
      const ch1 = new ClientHeadless(rb1, 80, 24);
      rb1.push("Same Content");
      const fp1 = await ch1.screenFingerprint();

      const rb2 = new RingBuffer();
      const ch2 = new ClientHeadless(rb2, 120, 40);
      rb2.push("Same Content");
      const fp2 = await ch2.screenFingerprint();

      assert.notStrictEqual(fp1, fp2);
      ch1.dispose();
      ch2.dispose();
    });

    it("is consistent for same state", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      rb.push("Consistent");
      const fp1 = await ch.screenFingerprint();
      const fp2 = await ch.screenFingerprint();

      assert.strictEqual(fp1, fp2);
      ch.dispose();
    });
  });

  describe("resize", () => {
    it("updates cols and rows", () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      ch.resize(120, 40);
      assert.strictEqual(ch.cols, 120);
      assert.strictEqual(ch.rows, 40);
      ch.dispose();
    });

    it("changes serialization output for same content", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      // Push a long line that will wrap differently at different widths
      const longLine = "A".repeat(100);
      rb.push(longLine);
      ch.replay();
      const screen80 = await ch.serializeScreen();

      ch.resize(40, 24);
      const screen40 = await ch.serializeScreen();

      // Different column widths should produce different serializations
      // because the 100-char line wraps at col 80 vs col 40
      assert.notStrictEqual(screen80, screen40);
      ch.dispose();
    });
  });

  describe("cursor", () => {
    it("returns cursor position", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      rb.push("Hello");
      ch.replay();
      // Flush to ensure write is processed
      await ch.serializeScreen();

      const cursor = ch.cursor;
      assert.strictEqual(typeof cursor.x, "number");
      assert.strictEqual(typeof cursor.y, "number");
      ch.dispose();
    });
  });

  describe("dispose", () => {
    it("disposes without error", () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      assert.doesNotThrow(() => ch.dispose());
    });

    it("can be called multiple times without error", () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      assert.doesNotThrow(() => {
        ch.dispose();
        ch.dispose();
      });
    });
  });

  describe("multiple replays are idempotent", () => {
    it("multiple replays with no new data produce same screen", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      rb.push("Stable content\r\n");
      ch.replay();
      const fp1 = await ch.screenFingerprint();

      ch.replay();
      const fp2 = await ch.screenFingerprint();

      ch.replay();
      const fp3 = await ch.screenFingerprint();

      assert.strictEqual(fp1, fp2);
      assert.strictEqual(fp2, fp3);
      ch.dispose();
    });
  });

  describe("replay from partial offset", () => {
    it("catches up from where it left off", async () => {
      const rb = new RingBuffer();
      const ch = new ClientHeadless(rb, 80, 24);

      // Push first batch and replay
      rb.push("Line1\r\n");
      ch.replay();
      const screen1 = await ch.serializeScreen();
      assert.ok(screen1.includes("Line1"));

      // Push second batch and replay (should only replay new data)
      rb.push("Line2\r\n");
      ch.replay();
      const screen2 = await ch.serializeScreen();
      assert.ok(screen2.includes("Line1"));
      assert.ok(screen2.includes("Line2"));

      // Push third batch
      rb.push("Line3\r\n");
      ch.replay();
      const screen3 = await ch.serializeScreen();
      assert.ok(screen3.includes("Line1"));
      assert.ok(screen3.includes("Line2"));
      assert.ok(screen3.includes("Line3"));
      ch.dispose();
    });
  });
});
