/**
 * /api/files/image route: unit tests
 *
 * Tests the image-serving endpoint used by the image-viewer tile.
 * Covers: supported formats, unsupported formats, size cap, path validation,
 * directory rejection, and missing files.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createFileBrowserRoutes } from "../lib/file-browser.js";

// --- Test helpers ---

function createMockReq(method, url) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:3000" };
  req.socket = { remoteAddress: "127.0.0.1" };
  process.nextTick(() => req.emit("end"));
  return req;
}

function createMockRes() {
  let _status = null;
  let _headers = {};
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  res.writeHead = (status, headers = {}) => {
    _status = status;
    Object.assign(_headers, headers);
  };
  res.setHeader = (k, v) => { _headers[k] = v; };
  Object.defineProperty(res, "status", { get: () => _status });
  Object.defineProperty(res, "headers", { get: () => _headers });
  Object.defineProperty(res, "bodyBuf", { get: () => Buffer.concat(chunks) });
  Object.defineProperty(res, "headersSent", { get: () => _status !== null });
  res.json = () => JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  return res;
}

function createRoutes() {
  const ctx = {
    json: (res, status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    },
    parseJSON: async (req) => {
      return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
        req.on("error", reject);
      });
    },
    auth: (handler) => handler,
    csrf: (handler) => handler,
  };
  return createFileBrowserRoutes(ctx);
}

function findRoute(routes, method, path) {
  return routes.find(r => r.method === method && r.path === path);
}

// --- Test data ---

let testDir;
let routes;

before(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "katulong-img-test-")));

  // PNG: valid magic bytes
  const pngBuf = Buffer.alloc(64);
  pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47;
  writeFileSync(join(testDir, "photo.png"), pngBuf);

  // JPEG
  const jpgBuf = Buffer.alloc(64);
  jpgBuf[0] = 0xff; jpgBuf[1] = 0xd8; jpgBuf[2] = 0xff;
  writeFileSync(join(testDir, "photo.jpg"), jpgBuf);

  // GIF
  writeFileSync(join(testDir, "anim.gif"), Buffer.from("GIF89a"));

  // SVG (text-based)
  writeFileSync(join(testDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  // Non-image file
  writeFileSync(join(testDir, "data.txt"), "hello");

  routes = createRoutes();
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// --- Tests ---

describe("GET /api/files/image", () => {
  it("serves a PNG file with correct content-type", async () => {
    const route = findRoute(routes, "GET", "/api/files/image");
    const req = createMockReq("GET", `/api/files/image?path=${encodeURIComponent(join(testDir, "photo.png"))}`);
    const res = createMockRes();
    await route.handler(req, res);
    // stream.pipe is async — wait for the writable to finish
    await new Promise(resolve => res.on("finish", resolve));

    assert.equal(res.status, 200);
    assert.equal(res.headers["Content-Type"], "image/png");
    assert.equal(res.bodyBuf.length, 64);
  });

  it("serves a JPEG file with correct content-type", async () => {
    const route = findRoute(routes, "GET", "/api/files/image");
    const req = createMockReq("GET", `/api/files/image?path=${encodeURIComponent(join(testDir, "photo.jpg"))}`);
    const res = createMockRes();
    await route.handler(req, res);
    await new Promise(resolve => res.on("finish", resolve));

    assert.equal(res.status, 200);
    assert.equal(res.headers["Content-Type"], "image/jpeg");
  });

  it("serves a GIF file with correct content-type", async () => {
    const route = findRoute(routes, "GET", "/api/files/image");
    const req = createMockReq("GET", `/api/files/image?path=${encodeURIComponent(join(testDir, "anim.gif"))}`);
    const res = createMockRes();
    await route.handler(req, res);
    await new Promise(resolve => res.on("finish", resolve));

    assert.equal(res.status, 200);
    assert.equal(res.headers["Content-Type"], "image/gif");
  });

  it("rejects SVG files (XSS risk — SVGs can contain executable JavaScript)", async () => {
    const route = findRoute(routes, "GET", "/api/files/image");
    const req = createMockReq("GET", `/api/files/image?path=${encodeURIComponent(join(testDir, "icon.svg"))}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 415);
    const data = res.json();
    assert.ok(data.error.includes("image format"));
  });

  it("returns 415 for non-image file extension", async () => {
    const route = findRoute(routes, "GET", "/api/files/image");
    const req = createMockReq("GET", `/api/files/image?path=${encodeURIComponent(join(testDir, "data.txt"))}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 415);
    const data = res.json();
    assert.ok(data.error.includes("image format"));
  });

  it("returns 400 without path parameter", async () => {
    const route = findRoute(routes, "GET", "/api/files/image");
    const req = createMockReq("GET", "/api/files/image");
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 400);
  });

  it("returns 400 for path traversal", async () => {
    const route = findRoute(routes, "GET", "/api/files/image");
    const req = createMockReq("GET", `/api/files/image?path=${encodeURIComponent(testDir + "/../etc/passwd.png")}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 400);
  });

  it("returns 404 for nonexistent image", async () => {
    const route = findRoute(routes, "GET", "/api/files/image");
    const req = createMockReq("GET", `/api/files/image?path=${encodeURIComponent(join(testDir, "nope.png"))}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 404);
  });

  it("returns 400 for directory", async () => {
    const route = findRoute(routes, "GET", "/api/files/image");
    const req = createMockReq("GET", `/api/files/image?path=${encodeURIComponent(testDir)}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 400);
    const data = res.json();
    assert.ok(data.error.includes("directory"));
  });
});
