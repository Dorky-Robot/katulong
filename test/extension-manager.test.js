import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listExtensions, extensionsDir, createExtensionRoutes } from "../lib/extension-manager.js";

describe("Extension Manager", () => {
  let dataDir;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-ext-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("extensionsDir", () => {
    it("returns <dataDir>/extensions", () => {
      assert.equal(extensionsDir(dataDir), join(dataDir, "extensions"));
    });
  });

  describe("listExtensions", () => {
    it("returns empty array when extensions dir does not exist", () => {
      const result = listExtensions(dataDir);
      assert.deepStrictEqual(result, []);
    });

    it("returns empty array when extensions dir is empty", () => {
      mkdirSync(join(dataDir, "extensions"));
      const result = listExtensions(dataDir);
      assert.deepStrictEqual(result, []);
    });

    it("lists valid extensions with manifest.json and tile.js", () => {
      const extDir = join(dataDir, "extensions", "my-ext");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "manifest.json"), JSON.stringify({
        name: "My Extension",
        type: "my-ext",
        description: "A test extension",
        icon: "star",
        version: "1.0.0",
        author: "test",
      }));
      writeFileSync(join(extDir, "tile.js"), "export function createTileFactory() {}");

      const result = listExtensions(dataDir);
      assert.equal(result.length, 1);
      assert.equal(result[0].name, "My Extension");
      assert.equal(result[0].type, "my-ext");
      assert.equal(result[0].version, "1.0.0");
      assert.equal(result[0]._dir, "my-ext");
    });

    it("skips directories without manifest.json", () => {
      const extDir = join(dataDir, "extensions", "no-manifest");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "tile.js"), "export function createTileFactory() {}");

      const result = listExtensions(dataDir);
      assert.deepStrictEqual(result, []);
    });

    it("skips directories without tile.js", () => {
      const extDir = join(dataDir, "extensions", "no-tile");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "manifest.json"), JSON.stringify({
        name: "No Tile",
        type: "no-tile",
      }));

      const result = listExtensions(dataDir);
      assert.deepStrictEqual(result, []);
    });

    it("skips manifests missing required fields", () => {
      const extDir = join(dataDir, "extensions", "bad-manifest");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "manifest.json"), JSON.stringify({ description: "missing name and type" }));
      writeFileSync(join(extDir, "tile.js"), "export function createTileFactory() {}");

      const result = listExtensions(dataDir);
      assert.deepStrictEqual(result, []);
    });

    it("skips hidden directories", () => {
      const extDir = join(dataDir, "extensions", ".hidden");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "manifest.json"), JSON.stringify({ name: "Hidden", type: "hidden" }));
      writeFileSync(join(extDir, "tile.js"), "export function createTileFactory() {}");

      const result = listExtensions(dataDir);
      assert.deepStrictEqual(result, []);
    });

    it("lists multiple extensions", () => {
      for (const name of ["alpha", "beta"]) {
        const extDir = join(dataDir, "extensions", name);
        mkdirSync(extDir, { recursive: true });
        writeFileSync(join(extDir, "manifest.json"), JSON.stringify({ name, type: name }));
        writeFileSync(join(extDir, "tile.js"), "export function createTileFactory() {}");
      }

      const result = listExtensions(dataDir);
      assert.equal(result.length, 2);
      const types = result.map(e => e.type).sort();
      assert.deepStrictEqual(types, ["alpha", "beta"]);
    });

    it("handles invalid JSON in manifest gracefully", () => {
      const extDir = join(dataDir, "extensions", "bad-json");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "manifest.json"), "not json{{{");
      writeFileSync(join(extDir, "tile.js"), "export function createTileFactory() {}");

      const result = listExtensions(dataDir);
      assert.deepStrictEqual(result, []);
    });
  });

  describe("createExtensionRoutes", () => {
    it("returns route definitions", () => {
      const routes = createExtensionRoutes({
        json: () => {},
        auth: (h) => h,
        DATA_DIR: dataDir,
      });

      assert.ok(Array.isArray(routes));
      assert.equal(routes.length, 2);

      // GET /api/extensions
      assert.equal(routes[0].method, "GET");
      assert.equal(routes[0].path, "/api/extensions");

      // GET /extensions/:name/...
      assert.equal(routes[1].method, "GET");
      assert.equal(routes[1].prefix, "/extensions/");
    });

    it("GET /api/extensions returns installed extensions", () => {
      const extDir = join(dataDir, "extensions", "test-ext");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "manifest.json"), JSON.stringify({
        name: "Test",
        type: "test",
        version: "1.0.0",
      }));
      writeFileSync(join(extDir, "tile.js"), "export function createTileFactory() {}");

      let responseCode, responseBody;
      const routes = createExtensionRoutes({
        json: (_res, code, body) => { responseCode = code; responseBody = body; },
        auth: (h) => h,
        DATA_DIR: dataDir,
      });

      routes[0].handler({}, {});
      assert.equal(responseCode, 200);
      assert.equal(responseBody.extensions.length, 1);
      assert.equal(responseBody.extensions[0].name, "Test");
      // Should not include internal _dir field
      assert.equal(responseBody.extensions[0]._dir, undefined);
    });

    it("serves tile.js for valid extension", () => {
      const extDir = join(dataDir, "extensions", "my-ext");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "manifest.json"), JSON.stringify({ name: "My Ext", type: "my-ext" }));
      writeFileSync(join(extDir, "tile.js"), "// tile code");

      let writtenHeaders, writtenBody;
      const mockRes = {
        writeHead: (code, headers) => { writtenHeaders = { code, ...headers }; },
        end: (body) => { writtenBody = body; },
      };

      let responseCode;
      const routes = createExtensionRoutes({
        json: (_res, code, body) => { responseCode = code; },
        auth: (h) => h,
        DATA_DIR: dataDir,
      });

      routes[1].handler({}, mockRes, "my-ext/tile.js");
      assert.equal(writtenHeaders.code, 200);
      assert.ok(writtenHeaders["Content-Type"].includes("application/javascript"));
      assert.equal(writtenBody, "// tile code");
    });

    it("serves manifest.json for valid extension", () => {
      const extDir = join(dataDir, "extensions", "my-ext");
      mkdirSync(extDir, { recursive: true });
      const manifest = { name: "My Ext", type: "my-ext" };
      writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(extDir, "tile.js"), "// tile code");

      let writtenHeaders, writtenBody;
      const mockRes = {
        writeHead: (code, headers) => { writtenHeaders = { code, ...headers }; },
        end: (body) => { writtenBody = body; },
      };

      const routes = createExtensionRoutes({
        json: () => {},
        auth: (h) => h,
        DATA_DIR: dataDir,
      });

      routes[1].handler({}, mockRes, "my-ext/manifest.json");
      assert.equal(writtenHeaders.code, 200);
      assert.ok(writtenHeaders["Content-Type"].includes("application/json"));
      assert.deepStrictEqual(JSON.parse(writtenBody), manifest);
    });

    it("returns 404 for non-existent extension", () => {
      let responseCode, responseBody;
      const routes = createExtensionRoutes({
        json: (_res, code, body) => { responseCode = code; responseBody = body; },
        auth: (h) => h,
        DATA_DIR: dataDir,
      });

      routes[1].handler({}, {}, "nonexistent/tile.js");
      assert.equal(responseCode, 404);
    });

    it("returns 404 for disallowed file names", () => {
      let responseCode;
      const routes = createExtensionRoutes({
        json: (_res, code) => { responseCode = code; },
        auth: (h) => h,
        DATA_DIR: dataDir,
      });

      // Only tile.js and manifest.json are allowed
      routes[1].handler({}, {}, "my-ext/secret.js");
      assert.equal(responseCode, 404);
    });

    it("rejects path traversal attempts", () => {
      let responseCode;
      const routes = createExtensionRoutes({
        json: (_res, code) => { responseCode = code; },
        auth: (h) => h,
        DATA_DIR: dataDir,
      });

      routes[1].handler({}, {}, "../etc/passwd");
      assert.equal(responseCode, 404);
    });
  });
});
