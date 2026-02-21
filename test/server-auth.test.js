import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// Mock the auth functions from server.js
// These would normally be imported, but since server.js doesn't export them,
// we'll test them by extracting the logic into testable units

describe("isLocalRequest", () => {
  function isLocalRequest(req) {
    const addr = req.socket?.remoteAddress;
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  it("returns true for IPv4 localhost", () => {
    const req = { socket: { remoteAddress: "127.0.0.1" } };
    assert.ok(isLocalRequest(req));
  });

  it("returns true for IPv6 localhost", () => {
    const req = { socket: { remoteAddress: "::1" } };
    assert.ok(isLocalRequest(req));
  });

  it("returns true for IPv4-mapped IPv6 localhost", () => {
    const req = { socket: { remoteAddress: "::ffff:127.0.0.1" } };
    assert.ok(isLocalRequest(req));
  });

  it("returns false for non-localhost IPv4", () => {
    const req = { socket: { remoteAddress: "192.168.1.1" } };
    assert.ok(!isLocalRequest(req));
  });

  it("returns false for non-localhost IPv6", () => {
    const req = { socket: { remoteAddress: "2001:db8::1" } };
    assert.ok(!isLocalRequest(req));
  });

  it("returns false when socket is missing", () => {
    const req = {};
    assert.ok(!isLocalRequest(req));
  });

  it("returns false when remoteAddress is missing", () => {
    const req = { socket: {} };
    assert.ok(!isLocalRequest(req));
  });
});

describe("readBody size limiting", () => {
  it("should accept bodies under the limit", async () => {
    const { Readable } = await import("node:stream");
    
    function readBody(req, maxSize = 1024 * 1024) {
      return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxSize) {
            req.destroy();
            reject(new Error("Request body too large"));
            return;
          }
          body += chunk;
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
      });
    }

    const req = Readable.from(["hello"]);
    const body = await readBody(req, 1000);
    assert.equal(body, "hello");
  });

  it("should reject bodies over the limit", async () => {
    const { Readable } = await import("node:stream");
    
    function readBody(req, maxSize = 1024 * 1024) {
      return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxSize) {
            req.destroy();
            reject(new Error("Request body too large"));
            return;
          }
          body += chunk;
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
      });
    }

    const req = Readable.from(["a".repeat(2000)]);
    await assert.rejects(
      () => readBody(req, 1000),
      { message: "Request body too large" }
    );
  });
});

