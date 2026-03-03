import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createFileBrowserRoutes } from "../lib/file-browser.js";

// --- Test helpers ---

function createMockReq(method, url, body, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:3000", ...headers };
  req.socket = { remoteAddress: "127.0.0.1" };
  // Simulate body stream
  if (body !== undefined) {
    const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    process.nextTick(() => {
      req.emit("data", buf);
      req.emit("end");
    });
  } else {
    process.nextTick(() => req.emit("end"));
  }
  return req;
}

function createMockRes() {
  let _status = null;
  let _headers = {};
  let _body = "";
  let _ended = false;
  const res = {
    writeHead(status, headers = {}) {
      _status = status;
      Object.assign(_headers, headers);
    },
    setHeader(k, v) { _headers[k] = v; },
    end(data) {
      if (data) _body += data;
      _ended = true;
    },
    // For pipe support
    on() { return res; },
    get status() { return _status; },
    get headers() { return _headers; },
    get body() { return _body; },
    get headersSent() { return _status !== null; },
    json() {
      return JSON.parse(_body);
    },
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

// --- Test data setup ---

let testDir;
let routes;

before(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "katulong-fb-test-")));
  // Create test structure
  writeFileSync(join(testDir, "hello.txt"), "Hello World");
  writeFileSync(join(testDir, "data.json"), '{"key":"value"}');
  mkdirSync(join(testDir, "subdir"));
  writeFileSync(join(testDir, "subdir", "nested.txt"), "nested content");
  mkdirSync(join(testDir, "emptydir"));
  // Symlink
  symlinkSync(join(testDir, "hello.txt"), join(testDir, "link.txt"));

  routes = createRoutes();
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// --- List directory ---

describe("GET /api/files (list)", () => {
  it("lists directory contents", async () => {
    const route = findRoute(routes, "GET", "/api/files");
    const req = createMockReq("GET", `/api/files?path=${encodeURIComponent(testDir)}`);
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.path, testDir);
    assert.ok(Array.isArray(data.entries));
    const names = data.entries.map(e => e.name).sort();
    assert.ok(names.includes("hello.txt"));
    assert.ok(names.includes("subdir"));
    assert.ok(names.includes("emptydir"));
  });

  it("returns entry metadata", async () => {
    const route = findRoute(routes, "GET", "/api/files");
    const req = createMockReq("GET", `/api/files?path=${encodeURIComponent(testDir)}`);
    const res = createMockRes();
    await route.handler(req, res);

    const data = res.json();
    const file = data.entries.find(e => e.name === "hello.txt");
    assert.equal(file.type, "file");
    assert.equal(file.size, 11); // "Hello World"
    assert.equal(file.kind, "Plain Text");
    assert.ok(file.modified);

    const dir = data.entries.find(e => e.name === "subdir");
    assert.equal(dir.type, "directory");
    assert.equal(dir.kind, "Folder");
  });

  it("returns 404 for nonexistent path", async () => {
    const route = findRoute(routes, "GET", "/api/files");
    const req = createMockReq("GET", `/api/files?path=${encodeURIComponent(join(testDir, "nope"))}`);
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 404);
  });

  it("returns 400 for path with ..", async () => {
    const route = findRoute(routes, "GET", "/api/files");
    const req = createMockReq("GET", `/api/files?path=${encodeURIComponent(testDir + "/../etc")}`);
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 400);
  });

  it("returns 400 for path with //", async () => {
    const route = findRoute(routes, "GET", "/api/files");
    const req = createMockReq("GET", `/api/files?path=${encodeURIComponent(testDir + "//subdir")}`);
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 400);
  });

  it("returns 400 for a file path (not directory)", async () => {
    const route = findRoute(routes, "GET", "/api/files");
    const req = createMockReq("GET", `/api/files?path=${encodeURIComponent(join(testDir, "hello.txt"))}`);
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 400);
  });
});

// --- Download ---

describe("GET /api/files/download", () => {
  it("streams a file download", async () => {
    const { PassThrough } = await import("node:stream");
    const route = findRoute(routes, "GET", "/api/files/download");
    const req = createMockReq("GET", `/api/files/download?path=${encodeURIComponent(join(testDir, "hello.txt"))}`);
    // Create a writable stream mock that supports pipe
    const dest = new PassThrough();
    let _status = null;
    let _headers = {};
    dest.writeHead = (status, headers = {}) => { _status = status; Object.assign(_headers, headers); };
    dest.setHeader = (k, v) => { _headers[k] = v; };
    dest.headersSent = false;

    await route.handler(req, dest);

    // Wait for stream to finish
    await new Promise(resolve => dest.on("finish", resolve).on("end", resolve));

    assert.equal(_status, 200);
    assert.ok(_headers["Content-Disposition"].includes("hello.txt"));
  });

  it("returns 400 without path", async () => {
    const route = findRoute(routes, "GET", "/api/files/download");
    const req = createMockReq("GET", "/api/files/download");
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 400);
  });

  it("returns 404 for nonexistent file", async () => {
    const route = findRoute(routes, "GET", "/api/files/download");
    const req = createMockReq("GET", `/api/files/download?path=${encodeURIComponent(join(testDir, "nope.txt"))}`);
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 404);
  });

  it("returns 400 for directory download", async () => {
    const route = findRoute(routes, "GET", "/api/files/download");
    const req = createMockReq("GET", `/api/files/download?path=${encodeURIComponent(testDir)}`);
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 400);
  });
});

// --- Mkdir ---

describe("POST /api/files/mkdir", () => {
  it("creates a new directory", async () => {
    const route = findRoute(routes, "POST", "/api/files/mkdir");
    const newDir = join(testDir, "newdir");
    const req = createMockReq("POST", "/api/files/mkdir", { path: newDir });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 201);
  });

  it("returns 409 for existing directory", async () => {
    const route = findRoute(routes, "POST", "/api/files/mkdir");
    const req = createMockReq("POST", "/api/files/mkdir", { path: join(testDir, "subdir") });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 409);
  });
});

// --- Rename ---

describe("POST /api/files/rename", () => {
  it("renames a file", async () => {
    const route = findRoute(routes, "POST", "/api/files/rename");
    // Create a file to rename
    const src = join(testDir, "rename-me.txt");
    writeFileSync(src, "rename test");
    const req = createMockReq("POST", "/api/files/rename", { path: src, name: "renamed.txt" });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 200);
    assert.ok(res.json().path.endsWith("renamed.txt"));
  });

  it("rejects name with /", async () => {
    const route = findRoute(routes, "POST", "/api/files/rename");
    const req = createMockReq("POST", "/api/files/rename", { path: join(testDir, "hello.txt"), name: "sub/bad.txt" });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 400);
  });

  it("rejects name ..", async () => {
    const route = findRoute(routes, "POST", "/api/files/rename");
    const req = createMockReq("POST", "/api/files/rename", { path: join(testDir, "hello.txt"), name: ".." });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 400);
  });
});

// --- Move ---

describe("POST /api/files/move", () => {
  it("moves files to a directory", async () => {
    const route = findRoute(routes, "POST", "/api/files/move");
    const src = join(testDir, "move-me.txt");
    writeFileSync(src, "move test");
    const req = createMockReq("POST", "/api/files/move", {
      items: [src],
      destination: join(testDir, "subdir"),
    });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 200);
    assert.ok(res.json().results[0].ok);
  });
});

// --- Copy ---

describe("POST /api/files/copy", () => {
  it("copies files to a directory", async () => {
    const route = findRoute(routes, "POST", "/api/files/copy");
    const req = createMockReq("POST", "/api/files/copy", {
      items: [join(testDir, "hello.txt")],
      destination: join(testDir, "emptydir"),
    });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 200);
    assert.ok(res.json().results[0].ok);
  });
});

// --- Delete ---

describe("POST /api/files/delete", () => {
  it("deletes a file", async () => {
    const route = findRoute(routes, "POST", "/api/files/delete");
    const src = join(testDir, "delete-me.txt");
    writeFileSync(src, "delete test");
    const req = createMockReq("POST", "/api/files/delete", { items: [src] });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 200);
    assert.ok(res.json().results[0].ok);
  });

  it("prevents deleting root /", async () => {
    const route = findRoute(routes, "POST", "/api/files/delete");
    const req = createMockReq("POST", "/api/files/delete", { items: ["/"] });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(data.results[0].error);
    assert.ok(data.results[0].error.includes("root"));
  });

  it("returns 400 for empty items", async () => {
    const route = findRoute(routes, "POST", "/api/files/delete");
    const req = createMockReq("POST", "/api/files/delete", { items: [] });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.status, 400);
  });
});
