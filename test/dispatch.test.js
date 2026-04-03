import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDispatchStore } from "../lib/dispatch-store.js";

describe("Dispatch Store", () => {
  let testDir;
  let store;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-dispatch-test-"));
    store = createDispatchStore(testDir);
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("addFeature", () => {
    it("creates a feature with status raw and returns it with an ID", () => {
      const feature = store.addFeature("build a spaceship");

      assert.ok(feature.id, "Should have an ID");
      assert.ok(feature.id.startsWith("f-"), "ID should start with f-");
      assert.equal(feature.raw, "build a spaceship");
      assert.equal(feature.status, "raw");
      assert.equal(feature.project, null);
      assert.equal(feature.refined, null);
      assert.equal(feature.execution, null);
      assert.ok(feature.createdAt, "Should have createdAt");
      assert.ok(feature.updatedAt, "Should have updatedAt");
    });

    it("assigns unique IDs to different features", () => {
      const f1 = store.addFeature("idea one");
      const f2 = store.addFeature("idea two");
      assert.notEqual(f1.id, f2.id, "IDs should be unique");
    });
  });

  describe("getFeature", () => {
    it("returns the feature by ID", () => {
      const created = store.addFeature("find me");
      const found = store.getFeature(created.id);

      assert.ok(found, "Should find the feature");
      assert.equal(found.id, created.id);
      assert.equal(found.raw, "find me");
    });

    it("returns null for unknown IDs", () => {
      const result = store.getFeature("f-nonexistent-0000");
      assert.equal(result, null);
    });
  });

  describe("updateFeature", () => {
    it("merges fields and updates updatedAt", async () => {
      const feature = store.addFeature("update me");
      const originalUpdatedAt = feature.updatedAt;

      // Small delay to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = store.updateFeature(feature.id, {
        status: "refined",
        project: "katulong",
      });

      assert.equal(updated.status, "refined");
      assert.equal(updated.project, "katulong");
      assert.equal(updated.raw, "update me", "Should preserve existing fields");
      assert.notEqual(updated.updatedAt, originalUpdatedAt, "updatedAt should change");
    });

    it("returns null for unknown IDs", () => {
      const result = store.updateFeature("f-nonexistent-0000", { status: "done" });
      assert.equal(result, null);
    });
  });

  describe("deleteFeature", () => {
    it("removes the feature and returns true", () => {
      const feature = store.addFeature("delete me");
      const result = store.deleteFeature(feature.id);

      assert.equal(result, true);
      assert.equal(store.getFeature(feature.id), null, "Feature should be gone");
    });

    it("returns false for unknown IDs", () => {
      const result = store.deleteFeature("f-nonexistent-0000");
      assert.equal(result, false);
    });
  });

  describe("listFeatures", () => {
    it("returns all features", () => {
      store.addFeature("one");
      store.addFeature("two");
      store.addFeature("three");

      const all = store.listFeatures();
      assert.equal(all.length, 3);
    });

    it("returns empty array when no features exist", () => {
      const all = store.listFeatures();
      assert.deepEqual(all, []);
    });

    it("with status filter returns only matching features", () => {
      const f1 = store.addFeature("raw one");
      store.addFeature("raw two");
      store.updateFeature(f1.id, { status: "active" });

      const rawFeatures = store.listFeatures("raw");
      assert.equal(rawFeatures.length, 1);
      assert.equal(rawFeatures[0].raw, "raw two");

      const activeFeatures = store.listFeatures("active");
      assert.equal(activeFeatures.length, 1);
      assert.equal(activeFeatures[0].id, f1.id);
    });
  });

  describe("getActiveByProject", () => {
    it("returns only active features for the given project", () => {
      const f1 = store.addFeature("feature A");
      const f2 = store.addFeature("feature B");
      const f3 = store.addFeature("feature C");
      store.addFeature("feature D");

      store.updateFeature(f1.id, { status: "active", project: "katulong" });
      store.updateFeature(f2.id, { status: "active", project: "diwa" });
      store.updateFeature(f3.id, { status: "done", project: "katulong" });

      const active = store.getActiveByProject("katulong");
      assert.equal(active.length, 1);
      assert.equal(active[0].id, f1.id);
    });

    it("returns empty array when no active features exist for the project", () => {
      const f1 = store.addFeature("feature A");
      store.updateFeature(f1.id, { status: "done", project: "katulong" });

      const active = store.getActiveByProject("katulong");
      assert.deepEqual(active, []);
    });
  });

  describe("addLog", () => {
    it("appends to execution.logs, creates execution object if missing", () => {
      const feature = store.addFeature("log test");
      assert.equal(feature.execution, null, "execution starts null");

      store.addLog(feature.id, "Step 1");
      store.addLog(feature.id, "Step 2");

      const updated = store.getFeature(feature.id);
      assert.ok(updated.execution, "execution should be created");
      assert.ok(Array.isArray(updated.execution.logs), "logs should be an array");
      assert.deepEqual(updated.execution.logs, ["Step 1", "Step 2"]);
    });

    it("caps logs at 200 entries", () => {
      const feature = store.addFeature("many logs");

      for (let i = 0; i < 210; i++) {
        store.addLog(feature.id, `log entry ${i}`);
      }

      const updated = store.getFeature(feature.id);
      assert.equal(updated.execution.logs.length, 200, "Should cap at 200");
      assert.equal(updated.execution.logs[0], "log entry 10", "Should keep the last 200");
      assert.equal(updated.execution.logs[199], "log entry 209");
    });

    it("is a no-op for unknown feature IDs", () => {
      // Should not throw
      store.addLog("f-nonexistent-0000", "ghost log");
    });
  });

  describe("atomic writes", () => {
    it("file is valid JSON after updates", () => {
      store.addFeature("one");
      store.addFeature("two");

      const filePath = join(testDir, "dispatch-features.json");
      assert.ok(existsSync(filePath), "File should exist");

      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      assert.equal(parsed.length, 2, "Should contain both features");
    });

    it("temp file is cleaned up after write", () => {
      store.addFeature("temp check");

      const tmpPath = join(testDir, "dispatch-features.json.tmp");
      assert.ok(!existsSync(tmpPath), "Temp file should not exist after write");
    });
  });

  describe("persistence across store instances", () => {
    it("features persist across store instances backed by the same directory", () => {
      const feature = store.addFeature("persist me");

      const store2 = createDispatchStore(testDir);
      const found = store2.getFeature(feature.id);

      assert.ok(found, "Feature should be found in second store instance");
      assert.equal(found.raw, "persist me");
      assert.equal(found.status, "raw");
    });

    it("updates from one instance are visible in another", () => {
      const feature = store.addFeature("shared state");
      store.updateFeature(feature.id, { status: "active" });

      const store2 = createDispatchStore(testDir);
      const found = store2.getFeature(feature.id);
      assert.equal(found.status, "active");
    });
  });
});

describe("Dispatch Routes", () => {
  // Route tests exercise the route handlers by creating a minimal context
  // with mock helpers, avoiding the need to start a full server.

  let testDir;
  let store;
  let routes;
  let routeMap;

  /**
   * Minimal mock for an HTTP response object.
   */
  function createMockRes() {
    const res = {
      statusCode: null,
      headers: {},
      body: null,
      writeHead(code, headers) {
        res.statusCode = code;
        Object.assign(res.headers, headers);
      },
      write(data) { res.body = (res.body || "") + data; },
      end(data) { if (data) res.body = (res.body || "") + data; },
    };
    return res;
  }

  /**
   * Minimal mock for an HTTP request with a JSON body.
   */
  function createMockReq(method, url, body, headers = {}) {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    return {
      method,
      url,
      headers: { host: "localhost:3000", ...headers },
      on(event, cb) {
        if (event === "data") chunks.forEach((c) => cb(c));
        if (event === "end") cb();
      },
    };
  }

  function json(res, status, data) {
    res.statusCode = status;
    res.body = JSON.stringify(data);
  }

  function parseJSON(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
  }

  // Auth and CSRF pass-through for unit tests (localhost is auto-authenticated)
  function auth(handler) { return handler; }
  function csrf(handler) { return handler; }

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-dispatch-route-test-"));
    store = createDispatchStore(testDir);

    const { createDispatchRoutes } = await import("../lib/dispatch-routes.js");
    routes = createDispatchRoutes({ store, json, parseJSON, auth, csrf });

    // Index routes by method+path for easy lookup
    routeMap = {};
    for (const r of routes) {
      const key = r.prefix
        ? `${r.method} PREFIX:${r.prefix}`
        : `${r.method} ${r.path}`;
      routeMap[key] = r;
    }
  });

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  describe("POST /api/dispatch/features", () => {
    it("with valid body returns 201 and the created feature", async () => {
      const route = routeMap["POST /api/dispatch/features"];
      assert.ok(route, "Route should exist");

      const req = createMockReq("POST", "/api/dispatch/features", { raw: "new idea" });
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.raw, "new idea");
      assert.equal(body.status, "raw");
      assert.ok(body.id);
    });

    it("with empty body returns 400", async () => {
      const route = routeMap["POST /api/dispatch/features"];
      const req = createMockReq("POST", "/api/dispatch/features", { raw: "" });
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 400);
    });

    it("with missing raw field returns 400", async () => {
      const route = routeMap["POST /api/dispatch/features"];
      const req = createMockReq("POST", "/api/dispatch/features", { title: "no raw" });
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 400);
    });
  });

  describe("GET /api/dispatch/features", () => {
    it("returns array of features", async () => {
      store.addFeature("alpha");
      store.addFeature("beta");

      const route = routeMap["GET /api/dispatch/features"];
      const req = createMockReq("GET", "/api/dispatch/features");
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 2);
    });

    it("returns empty array when no features exist", async () => {
      const route = routeMap["GET /api/dispatch/features"];
      const req = createMockReq("GET", "/api/dispatch/features");
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body, []);
    });
  });

  describe("GET /api/dispatch/features/<id>", () => {
    it("returns single feature", async () => {
      const feature = store.addFeature("find via route");

      const route = routeMap["GET PREFIX:/api/dispatch/features/"];
      const req = createMockReq("GET", `/api/dispatch/features/${feature.id}`);
      const res = createMockRes();
      await route.handler(req, res, feature.id);

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, feature.id);
      assert.equal(body.raw, "find via route");
    });

    it("returns 404 for unknown ID", async () => {
      const route = routeMap["GET PREFIX:/api/dispatch/features/"];
      const req = createMockReq("GET", "/api/dispatch/features/f-nonexistent");
      const res = createMockRes();
      await route.handler(req, res, "f-nonexistent");

      assert.equal(res.statusCode, 404);
    });
  });

  describe("PUT /api/dispatch/features/<id>", () => {
    it("updates fields", async () => {
      const feature = store.addFeature("update via route");

      const route = routeMap["PUT PREFIX:/api/dispatch/features/"];
      const req = createMockReq("PUT", `/api/dispatch/features/${feature.id}`, {
        status: "refined",
        project: "katulong",
      });
      const res = createMockRes();
      await route.handler(req, res, feature.id);

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, "refined");
      assert.equal(body.project, "katulong");
      assert.equal(body.raw, "update via route");
    });

    it("returns 404 for unknown ID", async () => {
      const route = routeMap["PUT PREFIX:/api/dispatch/features/"];
      const req = createMockReq("PUT", "/api/dispatch/features/f-nonexistent", {
        status: "done",
      });
      const res = createMockRes();
      await route.handler(req, res, "f-nonexistent");

      assert.equal(res.statusCode, 404);
    });
  });

  describe("DELETE /api/dispatch/features/<id>", () => {
    it("removes the feature", async () => {
      const feature = store.addFeature("delete via route");

      const route = routeMap["DELETE PREFIX:/api/dispatch/features/"];
      const req = createMockReq("DELETE", `/api/dispatch/features/${feature.id}`);
      const res = createMockRes();
      await route.handler(req, res, feature.id);

      assert.equal(res.statusCode, 200);
      assert.equal(store.getFeature(feature.id), null);
    });

    it("returns 404 for unknown ID", async () => {
      const route = routeMap["DELETE PREFIX:/api/dispatch/features/"];
      const req = createMockReq("DELETE", "/api/dispatch/features/f-nonexistent");
      const res = createMockRes();
      await route.handler(req, res, "f-nonexistent");

      assert.equal(res.statusCode, 404);
    });
  });

  describe("POST /api/dispatch/hook", () => {
    it("processes tool events and adds logs", async () => {
      const feature = store.addFeature("hook test");

      const route = routeMap["POST /api/dispatch/hook"];
      const req = createMockReq("POST", "/api/dispatch/hook", {
        feature_id: feature.id,
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      });
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 200);

      // The hook responds immediately, then processes async — but since
      // our parseJSON mock is synchronous in effect, the log is added inline.
      const updated = store.getFeature(feature.id);
      assert.ok(updated.execution, "execution should be created");
      assert.ok(updated.execution.logs.length > 0, "Should have log entries");
      assert.ok(
        updated.execution.logs[0].includes("Running tests"),
        "Should log test activity"
      );
    });

    it("maps Edit tool events to file editing logs", async () => {
      const feature = store.addFeature("edit hook test");

      const route = routeMap["POST /api/dispatch/hook"];
      const req = createMockReq("POST", "/api/dispatch/hook", {
        feature_id: feature.id,
        tool_name: "Edit",
        tool_input: { file_path: "/src/lib/dispatch-store.js" },
      });
      const res = createMockRes();
      await route.handler(req, res);

      const updated = store.getFeature(feature.id);
      assert.ok(
        updated.execution.logs[0].includes("Editing: dispatch-store.js"),
        "Should log the edited filename"
      );
    });

    it("maps Read/Grep/Glob tool events to reading logs", async () => {
      const feature = store.addFeature("read hook test");
      const route = routeMap["POST /api/dispatch/hook"];

      for (const tool of ["Read", "Grep", "Glob"]) {
        const req = createMockReq("POST", "/api/dispatch/hook", {
          feature_id: feature.id,
          tool_name: tool,
          tool_input: {},
        });
        const res = createMockRes();
        await route.handler(req, res);
      }

      const updated = store.getFeature(feature.id);
      assert.equal(updated.execution.logs.length, 3);
      assert.ok(updated.execution.logs.every((l) => l.includes("Reading codebase")));
    });

    it("ignores events without feature_id", async () => {
      const route = routeMap["POST /api/dispatch/hook"];
      const req = createMockReq("POST", "/api/dispatch/hook", {
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 200, "Should still respond 200");
    });
  });
});
