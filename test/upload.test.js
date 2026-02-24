import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { detectImage, readRawBody, MAX_UPLOAD_BYTES } from "../lib/routes/app.js";

describe("detectImage", () => {
  it("detects PNG magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    assert.equal(detectImage(buf), "png");
  });

  it("detects JPEG magic bytes", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    assert.equal(detectImage(buf), "jpg");
  });

  it("detects GIF magic bytes", () => {
    const buf = Buffer.from("GIF89a\x00\x00");
    assert.equal(detectImage(buf), "gif");
  });

  it("detects WebP magic bytes", () => {
    // RIFF....WEBP
    const buf = Buffer.alloc(16);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(100, 4);
    buf.write("WEBP", 8);
    assert.equal(detectImage(buf), "webp");
  });

  it("returns null for non-image data", () => {
    const buf = Buffer.from("hello world this is plain text");
    assert.equal(detectImage(buf), null);
  });

  it("returns null for empty buffer", () => {
    assert.equal(detectImage(Buffer.alloc(0)), null);
  });

  it("returns null for buffer too short for any signature", () => {
    assert.equal(detectImage(Buffer.from([0x89, 0x50])), null);
  });
});

describe("readRawBody", () => {
  function fakeReq(chunks) {
    const stream = new Readable({ read() {} });
    // Push chunks async
    setTimeout(() => {
      for (const chunk of chunks) stream.push(chunk);
      stream.push(null);
    }, 0);
    return stream;
  }

  it("reads a body correctly", async () => {
    const req = fakeReq([Buffer.from("hello"), Buffer.from(" world")]);
    const result = await readRawBody(req, 1024);
    assert.equal(result.toString(), "hello world");
  });

  it("rejects body exceeding limit", async () => {
    const req = fakeReq([Buffer.alloc(100)]);
    await assert.rejects(
      () => readRawBody(req, 50),
      { message: "Body too large" }
    );
  });

  it("handles empty body", async () => {
    const req = fakeReq([]);
    const result = await readRawBody(req, 1024);
    assert.equal(result.length, 0);
  });
});

describe("MAX_UPLOAD_BYTES", () => {
  it("is 10 MB", () => {
    assert.equal(MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
  });
});
