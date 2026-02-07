import { describe, it } from "node:test";
import assert from "node:assert";
import { RingBuffer } from "../lib/ring-buffer.js";

describe("RingBuffer", () => {
  describe("constructor", () => {
    it("creates buffer with default limits", () => {
      const buffer = new RingBuffer();
      const stats = buffer.stats();

      assert.strictEqual(stats.items, 0);
      assert.strictEqual(stats.bytes, 0);
      assert.strictEqual(buffer.maxItems, 5000);
      assert.strictEqual(buffer.maxBytes, 5 * 1024 * 1024);
    });

    it("creates buffer with custom limits", () => {
      const buffer = new RingBuffer(100, 1024);

      assert.strictEqual(buffer.maxItems, 100);
      assert.strictEqual(buffer.maxBytes, 1024);
    });
  });

  describe("push", () => {
    it("adds data to buffer", () => {
      const buffer = new RingBuffer();
      buffer.push("hello");
      buffer.push(" ");
      buffer.push("world");

      assert.strictEqual(buffer.toString(), "hello world");
      assert.strictEqual(buffer.stats().items, 3);
      assert.strictEqual(buffer.stats().bytes, 11);
    });

    it("tracks byte count correctly", () => {
      const buffer = new RingBuffer();
      buffer.push("a");    // 1 byte
      buffer.push("bb");   // 2 bytes
      buffer.push("ccc");  // 3 bytes

      assert.strictEqual(buffer.stats().bytes, 6);
    });
  });

  describe("eviction by item count", () => {
    it("evicts oldest items when maxItems exceeded", () => {
      const buffer = new RingBuffer(3, 1000000);
      buffer.push("first");
      buffer.push("second");
      buffer.push("third");
      buffer.push("fourth");  // Should evict "first"

      assert.strictEqual(buffer.toString(), "secondthirdfourth");
      assert.strictEqual(buffer.stats().items, 3);
    });

    it("evicts multiple items when far over limit", () => {
      const buffer = new RingBuffer(2, 1000000);
      buffer.push("a");
      buffer.push("b");
      buffer.push("c");
      buffer.push("d");
      buffer.push("e");

      assert.strictEqual(buffer.toString(), "de");
      assert.strictEqual(buffer.stats().items, 2);
    });
  });

  describe("eviction by byte size", () => {
    it("evicts oldest items when maxBytes exceeded", () => {
      const buffer = new RingBuffer(1000, 10);  // 10 byte limit
      buffer.push("abcd");   // 4 bytes
      buffer.push("efgh");   // 4 bytes, total 8
      buffer.push("ijkl");   // 4 bytes, total 12 -> evict "abcd", leaves 8

      assert.strictEqual(buffer.toString(), "efghijkl");
      assert.strictEqual(buffer.stats().bytes, 8);
    });

    it("evicts multiple items when far over byte limit", () => {
      const buffer = new RingBuffer(1000, 5);
      buffer.push("abc");   // 3 bytes
      buffer.push("def");   // 3 bytes, total 6 -> evict "abc", leaves 3
      buffer.push("ghi");   // 3 bytes, total 6 -> evict "def", leaves 3

      assert.strictEqual(buffer.toString(), "ghi");
      assert.strictEqual(buffer.stats().bytes, 3);
    });
  });

  describe("eviction by either limit", () => {
    it("evicts based on item limit when hit first", () => {
      const buffer = new RingBuffer(2, 1000);
      buffer.push("a");
      buffer.push("b");
      buffer.push("c");  // Item limit hit

      assert.strictEqual(buffer.toString(), "bc");
      assert.strictEqual(buffer.stats().items, 2);
    });

    it("evicts based on byte limit when hit first", () => {
      const buffer = new RingBuffer(100, 5);
      buffer.push("abc");
      buffer.push("def");  // Byte limit hit

      assert.strictEqual(buffer.toString(), "def");
      assert.strictEqual(buffer.stats().bytes, 3);
    });
  });

  describe("toString", () => {
    it("returns empty string for empty buffer", () => {
      const buffer = new RingBuffer();
      assert.strictEqual(buffer.toString(), "");
    });

    it("joins all items into single string", () => {
      const buffer = new RingBuffer();
      buffer.push("Hello");
      buffer.push(", ");
      buffer.push("world");
      buffer.push("!");

      assert.strictEqual(buffer.toString(), "Hello, world!");
    });
  });

  describe("clear", () => {
    it("removes all data", () => {
      const buffer = new RingBuffer();
      buffer.push("test");
      buffer.push("data");
      buffer.clear();

      assert.strictEqual(buffer.toString(), "");
      assert.strictEqual(buffer.stats().items, 0);
      assert.strictEqual(buffer.stats().bytes, 0);
    });
  });

  describe("stats", () => {
    it("returns accurate statistics", () => {
      const buffer = new RingBuffer();
      buffer.push("hello");  // 5 bytes
      buffer.push("world");  // 5 bytes

      const stats = buffer.stats();
      assert.strictEqual(stats.items, 2);
      assert.strictEqual(stats.bytes, 10);
    });
  });

  describe("edge cases", () => {
    it("handles empty strings", () => {
      const buffer = new RingBuffer();
      buffer.push("");
      buffer.push("test");
      buffer.push("");

      assert.strictEqual(buffer.toString(), "test");
      assert.strictEqual(buffer.stats().items, 3);
      assert.strictEqual(buffer.stats().bytes, 4);
    });

    it("handles single large item exceeding byte limit", () => {
      const buffer = new RingBuffer(100, 5);
      buffer.push("verylongstring");  // 14 bytes, exceeds limit

      // Should keep the item even though it exceeds limit
      // (eviction happens after push, but can't evict if only 1 item)
      assert.strictEqual(buffer.toString(), "verylongstring");
    });

    it("maintains correct state after multiple evictions", () => {
      const buffer = new RingBuffer(3, 20);

      for (let i = 0; i < 10; i++) {
        buffer.push(`item${i}`);
      }

      const stats = buffer.stats();
      assert.ok(stats.items <= 3);
      assert.ok(stats.bytes <= 20);
    });
  });

  describe("real-world terminal output simulation", () => {
    it("handles typical terminal output patterns", () => {
      const buffer = new RingBuffer(5000, 5 * 1024 * 1024);

      // Simulate command output
      buffer.push("$ ls -la\n");
      buffer.push("total 64\n");
      buffer.push("drwxr-xr-x  10 user  staff   320 Feb  7 10:00 .\n");
      buffer.push("drwxr-xr-x   5 user  staff   160 Feb  6 09:00 ..\n");

      const output = buffer.toString();
      assert.ok(output.includes("$ ls -la"));
      assert.ok(output.includes("total 64"));
      assert.strictEqual(buffer.stats().items, 4);
    });

    it("handles large streaming output", () => {
      const buffer = new RingBuffer(100, 1024);

      // Simulate large log output
      for (let i = 0; i < 200; i++) {
        buffer.push(`Line ${i}: some log data\n`);
      }

      const stats = buffer.stats();
      assert.ok(stats.items <= 100);
      assert.ok(stats.bytes <= 1024);

      // Should contain recent lines
      const output = buffer.toString();
      assert.ok(output.includes("Line 199"));
      assert.ok(!output.includes("Line 0"));  // Early lines evicted
    });
  });
});
