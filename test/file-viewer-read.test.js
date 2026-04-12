/**
 * /api/files/read route: unit tests
 *
 * Tests the inline file-reading endpoint used by the file-viewer tile.
 * Covers: text files, binary sniff rejection, size cap, path validation,
 * directory rejection, and missing files.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createFileBrowserRoutes } from "../lib/file-browser.js";

// --- Test helpers (same pattern as file-browser.test.js) ---

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
  let _body = "";
  const res = {
    writeHead(status, headers = {}) {
      _status = status;
      Object.assign(_headers, headers);
    },
    setHeader(k, v) { _headers[k] = v; },
    end(data) { if (data) _body += data; },
    on() { return res; },
    get status() { return _status; },
    get headers() { return _headers; },
    get body() { return _body; },
    get headersSent() { return _status !== null; },
    json() { return JSON.parse(_body); },
  };
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
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "katulong-fv-test-")));
  writeFileSync(join(testDir, "hello.txt"), "Hello World");
  writeFileSync(join(testDir, "code.js"), "const x = 42;\nconsole.log(x);\n");

  // Binary file — NUL byte in first 8KB
  const binBuf = Buffer.alloc(256);
  binBuf[0] = 0x89; // PNG-like header
  binBuf[1] = 0x50;
  binBuf[10] = 0x00; // NUL byte
  writeFileSync(join(testDir, "image.png"), binBuf);

  // Large file — over 1MB
  writeFileSync(join(testDir, "big.txt"), "x".repeat(1024 * 1024 + 1));

  routes = createRoutes();
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// --- Tests ---

describe("GET /api/files/read", () => {
  it("reads a text file and returns content with metadata", async () => {
    const route = findRoute(routes, "GET", "/api/files/read");
    const req = createMockReq("GET", `/api/files/read?path=${encodeURIComponent(join(testDir, "hello.txt"))}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.content, "Hello World");
    assert.equal(data.ext, ".txt");
    assert.equal(data.kind, "Plain Text");
    assert.equal(data.size, 11);
    assert.ok(data.path.endsWith("hello.txt"));
  });

  it("reads a .js file with correct metadata", async () => {
    const route = findRoute(routes, "GET", "/api/files/read");
    const req = createMockReq("GET", `/api/files/read?path=${encodeURIComponent(join(testDir, "code.js"))}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.ext, ".js");
    assert.equal(data.kind, "JavaScript");
    assert.ok(data.content.includes("const x = 42"));
  });

  it("returns 415 for binary file (NUL byte in first 8KB)", async () => {
    const route = findRoute(routes, "GET", "/api/files/read");
    const req = createMockReq("GET", `/api/files/read?path=${encodeURIComponent(join(testDir, "image.png"))}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 415);
    const data = res.json();
    assert.ok(data.error.toLowerCase().includes("binary"));
  });

  it("returns 413 for file over 1MB", async () => {
    const route = findRoute(routes, "GET", "/api/files/read");
    const req = createMockReq("GET", `/api/files/read?path=${encodeURIComponent(join(testDir, "big.txt"))}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 413);
    const data = res.json();
    assert.ok(data.error.includes("1 MB"));
  });

  it("returns 400 without path parameter", async () => {
    const route = findRoute(routes, "GET", "/api/files/read");
    const req = createMockReq("GET", "/api/files/read");
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 400);
  });

  it("returns 400 for path with ..", async () => {
    const route = findRoute(routes, "GET", "/api/files/read");
    const req = createMockReq("GET", `/api/files/read?path=${encodeURIComponent(testDir + "/../etc/passwd")}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 400);
  });

  it("returns 404 for nonexistent file", async () => {
    const route = findRoute(routes, "GET", "/api/files/read");
    const req = createMockReq("GET", `/api/files/read?path=${encodeURIComponent(join(testDir, "nope.txt"))}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 404);
  });

  it("returns 400 for directory", async () => {
    const route = findRoute(routes, "GET", "/api/files/read");
    const req = createMockReq("GET", `/api/files/read?path=${encodeURIComponent(testDir)}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 400);
    const data = res.json();
    assert.ok(data.error.includes("directory"));
  });
});
