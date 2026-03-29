import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverTileExtensions } from "../lib/tile-extensions.js";

describe("discoverTileExtensions", () => {
  let dataDir;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tile-ext-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns empty array when tiles directory does not exist", () => {
    const result = discoverTileExtensions(dataDir);
    assert.deepStrictEqual(result, []);
  });

  it("discovers a valid tile extension", () => {
    const tilesDir = join(dataDir, "tiles", "plano");
    mkdirSync(tilesDir, { recursive: true });
    writeFileSync(join(tilesDir, "manifest.json"), JSON.stringify({
      name: "Plano",
      type: "plano",
      description: "Notes tile",
      icon: "note-pencil",
      version: "0.1.0",
    }));
    writeFileSync(join(tilesDir, "tile.js"), "export default function setup() {}");

    const result = discoverTileExtensions(dataDir);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "plano");
    assert.strictEqual(result[0].manifest.name, "Plano");
    assert.strictEqual(result[0].manifest.type, "plano");
    assert.ok(result[0].dir.endsWith("/plano"));
  });

  it("skips directories without manifest.json", () => {
    const tilesDir = join(dataDir, "tiles", "no-manifest");
    mkdirSync(tilesDir, { recursive: true });
    writeFileSync(join(tilesDir, "tile.js"), "export default function setup() {}");

    const result = discoverTileExtensions(dataDir);
    assert.strictEqual(result.length, 0);
  });

  it("skips directories without tile.js", () => {
    const tilesDir = join(dataDir, "tiles", "no-tile");
    mkdirSync(tilesDir, { recursive: true });
    writeFileSync(join(tilesDir, "manifest.json"), JSON.stringify({ name: "Test" }));

    const result = discoverTileExtensions(dataDir);
    assert.strictEqual(result.length, 0);
  });

  it("skips manifests without a name field", () => {
    const tilesDir = join(dataDir, "tiles", "no-name");
    mkdirSync(tilesDir, { recursive: true });
    writeFileSync(join(tilesDir, "manifest.json"), JSON.stringify({ type: "test" }));
    writeFileSync(join(tilesDir, "tile.js"), "export default function setup() {}");

    const result = discoverTileExtensions(dataDir);
    assert.strictEqual(result.length, 0);
  });

  it("skips hidden directories", () => {
    const tilesDir = join(dataDir, "tiles", ".hidden");
    mkdirSync(tilesDir, { recursive: true });
    writeFileSync(join(tilesDir, "manifest.json"), JSON.stringify({ name: "Hidden" }));
    writeFileSync(join(tilesDir, "tile.js"), "export default function setup() {}");

    const result = discoverTileExtensions(dataDir);
    assert.strictEqual(result.length, 0);
  });

  it("skips manifests with invalid JSON", () => {
    const tilesDir = join(dataDir, "tiles", "bad-json");
    mkdirSync(tilesDir, { recursive: true });
    writeFileSync(join(tilesDir, "manifest.json"), "not-valid-json{{{");
    writeFileSync(join(tilesDir, "tile.js"), "export default function setup() {}");

    const result = discoverTileExtensions(dataDir);
    assert.strictEqual(result.length, 0);
  });

  it("discovers multiple extensions", () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      const dir = join(dataDir, "tiles", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: name.toUpperCase() }));
      writeFileSync(join(dir, "tile.js"), "export default function setup() {}");
    }

    const result = discoverTileExtensions(dataDir);
    assert.strictEqual(result.length, 3);
    const names = result.map(r => r.manifest.name).sort();
    assert.deepStrictEqual(names, ["ALPHA", "BETA", "GAMMA"]);
  });
});

describe("createTileExtensionRoutes", () => {
  let dataDir;
  let routes;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "tile-route-test-"));
    const tilesDir = join(dataDir, "tiles", "demo");
    mkdirSync(tilesDir, { recursive: true });
    writeFileSync(join(tilesDir, "manifest.json"), JSON.stringify({
      name: "Demo", type: "demo", description: "Test", icon: "star",
    }));
    writeFileSync(join(tilesDir, "tile.js"), 'export default function setup() { return () => ({}); }');
    writeFileSync(join(tilesDir, "style.css"), "body { color: red; }");

    const { createTileExtensionRoutes } = await import("../lib/tile-extensions.js");
    routes = createTileExtensionRoutes({
      json: (res, status, body) => { res._status = status; res._body = body; },
      auth: (handler) => handler,
      DATA_DIR: dataDir,
    });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates two routes (list + serve)", () => {
    assert.strictEqual(routes.length, 2);
    assert.strictEqual(routes[0].method, "GET");
    assert.strictEqual(routes[0].path, "/api/tile-extensions");
    assert.strictEqual(routes[1].method, "GET");
    assert.strictEqual(routes[1].prefix, "/tiles/");
  });

  it("list route returns discovered extensions", () => {
    const res = { _status: null, _body: null };
    routes[0].handler({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.extensions.length, 1);
    assert.strictEqual(res._body.extensions[0].name, "Demo");
    assert.strictEqual(res._body.extensions[0].type, "demo");
  });

  it("file route serves tile.js with correct MIME type", () => {
    const res = {
      _headers: {},
      writeHead(status, headers) { this._status = status; this._headers = headers; },
      end(content) { this._content = content; },
    };
    routes[1].handler({}, res, "demo/tile.js");
    assert.strictEqual(res._status, 200);
    assert.ok(res._headers["Content-Type"].includes("javascript"));
  });

  it("file route serves CSS with correct MIME type", () => {
    const res = {
      _headers: {},
      writeHead(status, headers) { this._status = status; this._headers = headers; },
      end(content) { this._content = content; },
    };
    routes[1].handler({}, res, "demo/style.css");
    assert.strictEqual(res._status, 200);
    assert.ok(res._headers["Content-Type"].includes("text/css"));
  });

  it("file route returns 404 for missing file", () => {
    const res = { _status: null, _body: null };
    routes[1].handler({}, res, "demo/nonexistent.js");
    assert.strictEqual(res._status, 404);
  });

  it("file route returns 404 for unknown extension", () => {
    const res = { _status: null, _body: null };
    routes[1].handler({}, res, "unknown/tile.js");
    assert.strictEqual(res._status, 404);
  });

  it("file route rejects path traversal", () => {
    const res = {
      _status: null, _body: null, _headers: {},
      writeHead(status, headers) { this._status = status; this._headers = headers; },
      end() {},
    };
    routes[1].handler({}, res, "demo/../../../etc/passwd");
    assert.ok(res._status === 403 || res._status === 404);
  });

  it("file route rejects invalid extension names", () => {
    const res = { _status: null, _body: null };
    routes[1].handler({}, res, "../../etc/passwd");
    assert.strictEqual(res._status, 400);
  });

  it("file route returns 404 when param has no slash", () => {
    const res = { _status: null, _body: null };
    routes[1].handler({}, res, "noslash");
    assert.strictEqual(res._status, 404);
  });
});
