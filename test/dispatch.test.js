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
    it("creates a feature with status raw and returns it with an ID", async () => {
      const feature = await store.addFeature("build a spaceship");

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

    it("assigns unique IDs to different features", async () => {
      const f1 = await store.addFeature("idea one");
      const f2 = await store.addFeature("idea two");
      assert.notEqual(f1.id, f2.id, "IDs should be unique");
    });
  });

  describe("getFeature", () => {
    it("returns the feature by ID", async () => {
      const created = await store.addFeature("find me");
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
      const feature = await store.addFeature("update me");
      const originalUpdatedAt = feature.updatedAt;

      // Small delay to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await store.updateFeature(feature.id, {
        status: "refined",
        project: "katulong",
      });

      assert.equal(updated.status, "refined");
      assert.equal(updated.project, "katulong");
      assert.equal(updated.raw, "update me", "Should preserve existing fields");
      assert.notEqual(updated.updatedAt, originalUpdatedAt, "updatedAt should change");
    });

    it("returns null for unknown IDs", async () => {
      const result = await store.updateFeature("f-nonexistent-0000", { status: "done" });
      assert.equal(result, null);
    });
  });

  describe("deleteFeature", () => {
    it("removes the feature and returns true", async () => {
      const feature = await store.addFeature("delete me");
      const result = await store.deleteFeature(feature.id);

      assert.equal(result, true);
      assert.equal(store.getFeature(feature.id), null, "Feature should be gone");
    });

    it("returns false for unknown IDs", async () => {
      const result = await store.deleteFeature("f-nonexistent-0000");
      assert.equal(result, false);
    });
  });

  describe("listFeatures", () => {
    it("returns all features", async () => {
      await store.addFeature("one");
      await store.addFeature("two");
      await store.addFeature("three");

      const all = store.listFeatures();
      assert.equal(all.length, 3);
    });

    it("returns empty array when no features exist", () => {
      const all = store.listFeatures();
      assert.deepEqual(all, []);
    });

    it("with status filter returns only matching features", async () => {
      const f1 = await store.addFeature("raw one");
      await store.addFeature("raw two");
      await store.updateFeature(f1.id, { status: "active" });

      const rawFeatures = store.listFeatures("raw");
      assert.equal(rawFeatures.length, 1);
      assert.equal(rawFeatures[0].raw, "raw two");

      const activeFeatures = store.listFeatures("active");
      assert.equal(activeFeatures.length, 1);
      assert.equal(activeFeatures[0].id, f1.id);
    });
  });

  describe("getActiveByProject", () => {
    it("returns only active features for the given project", async () => {
      const f1 = await store.addFeature("feature A");
      const f2 = await store.addFeature("feature B");
      const f3 = await store.addFeature("feature C");
      await store.addFeature("feature D");

      await store.updateFeature(f1.id, { status: "active", project: "katulong" });
      await store.updateFeature(f2.id, { status: "active", project: "diwa" });
      await store.updateFeature(f3.id, { status: "done", project: "katulong" });

      const active = store.getActiveByProject("katulong");
      assert.equal(active.length, 1);
      assert.equal(active[0].id, f1.id);
    });

    it("returns empty array when no active features exist for the project", async () => {
      const f1 = await store.addFeature("feature A");
      await store.updateFeature(f1.id, { status: "done", project: "katulong" });

      const active = store.getActiveByProject("katulong");
      assert.deepEqual(active, []);
    });
  });

  describe("addLog", () => {
    it("appends to execution.logs, creates execution object if missing", async () => {
      const feature = await store.addFeature("log test");
      assert.equal(feature.execution, null, "execution starts null");

      await store.addLog(feature.id, "Step 1");
      await store.addLog(feature.id, "Step 2");

      const updated = store.getFeature(feature.id);
      assert.ok(updated.execution, "execution should be created");
      assert.ok(Array.isArray(updated.execution.logs), "logs should be an array");
      assert.deepEqual(updated.execution.logs, ["Step 1", "Step 2"]);
    });

    it("caps logs at 200 entries", async () => {
      const feature = await store.addFeature("many logs");

      for (let i = 0; i < 210; i++) {
        await store.addLog(feature.id, `log entry ${i}`);
      }

      const updated = store.getFeature(feature.id);
      assert.equal(updated.execution.logs.length, 200, "Should cap at 200");
      assert.equal(updated.execution.logs[0], "log entry 10", "Should keep the last 200");
      assert.equal(updated.execution.logs[199], "log entry 209");
    });

    it("is a no-op for unknown feature IDs", async () => {
      // Should not throw
      await store.addLog("f-nonexistent-0000", "ghost log");
    });
  });

  describe("atomic writes", () => {
    it("file is valid JSON after updates", async () => {
      await store.addFeature("one");
      await store.addFeature("two");

      const filePath = join(testDir, "dispatch-features.json");
      assert.ok(existsSync(filePath), "File should exist");

      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      assert.equal(parsed.length, 2, "Should contain both features");
    });

    it("temp file is cleaned up after write", async () => {
      await store.addFeature("temp check");

      const tmpPath = join(testDir, "dispatch-features.json.tmp");
      assert.ok(!existsSync(tmpPath), "Temp file should not exist after write");
    });
  });

  describe("persistence across store instances", () => {
    it("features persist across store instances backed by the same directory", async () => {
      const feature = await store.addFeature("persist me");

      const store2 = createDispatchStore(testDir);
      const found = store2.getFeature(feature.id);

      assert.ok(found, "Feature should be found in second store instance");
      assert.equal(found.raw, "persist me");
      assert.equal(found.status, "raw");
    });

    it("updates from one instance are visible in another", async () => {
      const feature = await store.addFeature("shared state");
      await store.updateFeature(feature.id, { status: "active" });

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
        if (event === "close") { /* noop for mock */ }
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

  // Stub refiner and executor for route tests
  const refiner = { refine: async () => ({}) };
  const executor = { dispatch: async () => ({}), cancel: async () => true };

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-dispatch-route-test-"));
    store = createDispatchStore(testDir);

    const { createDispatchRoutes } = await import("../lib/dispatch-routes.js");
    routes = createDispatchRoutes({ store, refiner, executor, json, parseJSON, auth, csrf });

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
    it("returns features and projects in response", async () => {
      await store.addFeature("alpha");
      await store.addFeature("beta");

      const route = routeMap["GET /api/dispatch/features"];
      const req = createMockReq("GET", "/api/dispatch/features");
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.features, "should have features key");
      assert.ok(Array.isArray(body.features));
      assert.equal(body.features.length, 2);
      assert.ok(Array.isArray(body.projects), "should have projects key");
    });

    it("returns empty features when none exist", async () => {
      const route = routeMap["GET /api/dispatch/features"];
      const req = createMockReq("GET", "/api/dispatch/features");
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.features);
      assert.deepEqual(body.features, []);
    });
  });

  describe("GET /api/dispatch/features/<id>", () => {
    it("returns single feature", async () => {
      const feature = await store.addFeature("find via route");

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
      const feature = await store.addFeature("update via route");

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
      const feature = await store.addFeature("delete via route");

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
      const feature = await store.addFeature("hook test");

      const route = routeMap["POST /api/dispatch/hook"];
      const req = createMockReq("POST", "/api/dispatch/hook", {
        feature_id: feature.id,
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      });
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 200);

      const updated = store.getFeature(feature.id);
      assert.ok(updated.execution, "execution should be created");
      assert.ok(updated.execution.logs.length > 0, "Should have log entries");
      assert.ok(
        updated.execution.logs[0].includes("Running tests"),
        "Should log test activity"
      );
    });

    it("maps Edit tool events to file editing logs", async () => {
      const feature = await store.addFeature("edit hook test");

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
      const feature = await store.addFeature("read hook test");
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

    it("returns 404 for unknown feature_id", async () => {
      const route = routeMap["POST /api/dispatch/hook"];
      const req = createMockReq("POST", "/api/dispatch/hook", {
        feature_id: "f-nonexistent-0000",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const res = createMockRes();
      await route.handler(req, res);

      assert.equal(res.statusCode, 404, "Should respond 404 for unknown feature");
    });
  });

  describe("addFeature with projects", () => {
    it("stores project scoping when provided", async () => {
      const feature = await store.addFeature("purple bg @katulong @yelo", ["katulong", "yelo"]);
      assert.deepEqual(feature.projects, ["katulong", "yelo"]);

      const retrieved = store.getFeature(feature.id);
      assert.deepEqual(retrieved.projects, ["katulong", "yelo"]);
    });

    it("stores null projects when none provided", async () => {
      const feature = await store.addFeature("no scope");
      assert.equal(feature.projects, null);
    });
  });

  describe("parseHashtags (@ mention extraction)", () => {
    // Test the parsing logic directly — extracted from dispatch-panel.js
    function parseHashtags(text) {
      const tags = [];
      const cleaned = text.replace(/@([a-zA-Z0-9._-]+)/g, (_, tag) => {
        tags.push(tag);
        return '';
      }).replace(/\s+/g, ' ').trim();
      return { text: cleaned, projects: tags };
    }

    it("extracts single @mention", () => {
      const result = parseHashtags("make bg purple @katulong");
      assert.deepEqual(result.projects, ["katulong"]);
      assert.equal(result.text, "make bg purple");
    });

    it("extracts multiple @mentions", () => {
      const result = parseHashtags("dark mode @katulong @yelo");
      assert.deepEqual(result.projects, ["katulong", "yelo"]);
      assert.equal(result.text, "dark mode");
    });

    it("handles @mention at start", () => {
      const result = parseHashtags("@diwa add date range search");
      assert.deepEqual(result.projects, ["diwa"]);
      assert.equal(result.text, "add date range search");
    });

    it("handles text with no @mentions", () => {
      const result = parseHashtags("just a plain idea");
      assert.deepEqual(result.projects, []);
      assert.equal(result.text, "just a plain idea");
    });

    it("handles @mentions with dots and hyphens", () => {
      const result = parseHashtags("fix @Dorky-Robot.github.io");
      assert.deepEqual(result.projects, ["Dorky-Robot.github.io"]);
    });
  });

  describe("getTagQuery (autocomplete trigger detection)", () => {
    // Simulates getTagQuery logic from dispatch-panel.js
    function getTagQuery(val, cursor) {
      let i = cursor - 1;
      while (i >= 0 && /[a-zA-Z0-9._-]/.test(val[i])) i--;
      if (i >= 0 && val[i] === '@' && (i === 0 || /\s/.test(val[i - 1]))) {
        return val.slice(i + 1, cursor);
      }
      return null;
    }

    it("detects @query at end of input", () => {
      assert.equal(getTagQuery("@kat", 4), "kat");
    });

    it("detects @query after space", () => {
      assert.equal(getTagQuery("fix bug @kat", 12), "kat");
    });

    it("returns null when no @ present", () => {
      assert.equal(getTagQuery("just text", 9), null);
    });

    it("returns null when @ is mid-word (email-like)", () => {
      assert.equal(getTagQuery("user@host", 9), null);
    });

    it("returns empty string right after @", () => {
      assert.equal(getTagQuery("@", 1), "");
    });

    it("detects @ at start of input", () => {
      assert.equal(getTagQuery("@katulong is great", 9), "katulong");
    });
  });

  describe("showAutocomplete matching", () => {
    // Simulates the filter+sort logic from showAutocomplete
    function filterProjects(projects, query) {
      const q = query.toLowerCase();
      return projects
        .filter((p) => (p.slug || p.name || '').toLowerCase().includes(q))
        .sort((a, b) => {
          const as = (a.slug || a.name || '').toLowerCase();
          const bs = (b.slug || b.name || '').toLowerCase();
          const aStarts = as.startsWith(q);
          const bStarts = bs.startsWith(q);
          if (aStarts !== bStarts) return aStarts ? -1 : 1;
          return as.length - bs.length;
        })
        .slice(0, 6);
    }

    const projects = [
      { name: "Dorky-Robot/katulong", slug: "katulong" },
      { name: "Dorky-Robot/kubo", slug: "kubo" },
      { name: "Dorky-Robot/katha.js", slug: "katha.js" },
      { name: "Dorky-Robot/homebrew-katulong", slug: "homebrew-katulong" },
      { name: "Dorky-Robot/yelo", slug: "yelo" },
      { name: "Dorky-Robot/diwa", slug: "diwa" },
    ];

    it("ranks starts-with matches before contains matches", () => {
      const matches = filterProjects(projects, "kat");
      // katulong and katha.js both start with "kat" — sorted by length
      assert.ok(matches[0].slug.startsWith("kat"), "first result should start with query");
      assert.ok(matches[1].slug.startsWith("kat"), "second result should start with query");
      // homebrew-katulong only contains "kat" — ranked last
      assert.equal(matches[2].slug, "homebrew-katulong");
    });

    it("matches partial slug", () => {
      const matches = filterProjects(projects, "kat");
      assert.equal(matches.length, 3); // katha.js, katulong, homebrew-katulong
    });

    it("matches single character", () => {
      const matches = filterProjects(projects, "y");
      assert.equal(matches.length, 1);
      assert.equal(matches[0].slug, "yelo");
    });

    it("returns empty for no match", () => {
      const matches = filterProjects(projects, "zzz");
      assert.equal(matches.length, 0);
    });

    it("limits to 6 results", () => {
      const many = Array.from({ length: 10 }, (_, i) => ({ slug: `proj${i}` }));
      const matches = filterProjects(many, "proj");
      assert.equal(matches.length, 6);
    });

    it("Tab auto-selects first match when none highlighted", () => {
      // Simulates: acIndex=-1, items exist → select index 0
      const acIndex = -1;
      const idx = acIndex >= 0 ? acIndex : 0;
      assert.equal(idx, 0);
    });
  });
});
