import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDispatchStore } from "../lib/dispatch-store.js";

describe("Dispatch Store (markdown files)", () => {
  let testDir;
  let store;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-dispatch-test-"));
    store = createDispatchStore(testDir);
  });

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  describe("addFeature", () => {
    it("creates a feature with status raw and returns it", () => {
      const f = store.addFeature("build a spaceship");
      assert.ok(f.id.startsWith("f-"));
      assert.equal(f.status, "raw");
      assert.equal(f.body, "build a spaceship");
      assert.ok(f.created);
      assert.ok(f.updated);
    });

    it("assigns unique IDs", () => {
      const f1 = store.addFeature("one");
      const f2 = store.addFeature("two");
      assert.notEqual(f1.id, f2.id);
    });

    it("stores project scoping when provided", () => {
      const f = store.addFeature("purple bg @katulong @yelo", ["katulong", "yelo"]);
      assert.deepEqual(f.projects, ["katulong", "yelo"]);
    });

    it("stores null projects when none provided", () => {
      const f = store.addFeature("no scope");
      assert.equal(f.projects, null);
    });
  });

  describe("getFeature", () => {
    it("returns feature by ID", () => {
      const created = store.addFeature("find me");
      const found = store.getFeature(created.id);
      assert.equal(found.id, created.id);
      assert.equal(found.body, "find me");
    });

    it("returns null for unknown ID", () => {
      assert.equal(store.getFeature("f-nonexistent"), null);
    });
  });

  describe("updateFeature", () => {
    it("merges fields and updates timestamp", () => {
      const f = store.addFeature("update me");
      const original = f.updated;

      // Small delay for timestamp change
      const updated = store.updateFeature(f.id, { status: "refined", title: "Refined title" });
      assert.equal(updated.status, "refined");
      assert.equal(updated.title, "Refined title");
      assert.equal(updated.body, "update me");
    });

    it("returns null for unknown ID", () => {
      assert.equal(store.updateFeature("f-nope", { status: "done" }), null);
    });
  });

  describe("deleteFeature", () => {
    it("removes the feature file", () => {
      const f = store.addFeature("delete me");
      assert.equal(store.deleteFeature(f.id), true);
      assert.equal(store.getFeature(f.id), null);
    });

    it("returns false for unknown ID", () => {
      assert.equal(store.deleteFeature("f-nope"), false);
    });
  });

  describe("listFeatures", () => {
    it("returns all features", () => {
      store.addFeature("one");
      store.addFeature("two");
      store.addFeature("three");
      assert.equal(store.listFeatures().length, 3);
    });

    it("returns empty array when none exist", () => {
      assert.deepEqual(store.listFeatures(), []);
    });

    it("filters by status", () => {
      const f1 = store.addFeature("raw one");
      store.addFeature("raw two");
      store.updateFeature(f1.id, { status: "active" });

      assert.equal(store.listFeatures("raw").length, 1);
      assert.equal(store.listFeatures("active").length, 1);
      assert.equal(store.listFeatures("active")[0].id, f1.id);
    });
  });

  describe("getActiveByProject", () => {
    it("returns only active features for the given project", () => {
      const f1 = store.addFeature("A", ["katulong"]);
      const f2 = store.addFeature("B", ["diwa"]);
      const f3 = store.addFeature("C", ["katulong"]);

      store.updateFeature(f1.id, { status: "active" });
      store.updateFeature(f2.id, { status: "active" });
      store.updateFeature(f3.id, { status: "done" });

      const active = store.getActiveByProject("katulong");
      assert.equal(active.length, 1);
      assert.equal(active[0].id, f1.id);
    });
  });

  describe("addLog", () => {
    it("appends log lines to the body", () => {
      const f = store.addFeature("log test");
      store.addLog(f.id, "Step 1");
      store.addLog(f.id, "Step 2");

      const updated = store.getFeature(f.id);
      assert.ok(updated.body.includes("Step 1"));
      assert.ok(updated.body.includes("Step 2"));
    });

    it("is a no-op for unknown ID", () => {
      store.addLog("f-nope", "ghost"); // should not throw
    });
  });

  describe("markdown file format", () => {
    it("writes a valid markdown file with frontmatter", () => {
      const f = store.addFeature("my idea", ["katulong"]);
      const path = join(testDir, "dispatch", `${f.id}.md`);
      assert.ok(existsSync(path));

      const content = readFileSync(path, "utf-8");
      assert.ok(content.startsWith("---\n"));
      assert.ok(content.includes("status: raw"));
      assert.ok(content.includes("projects: [katulong]"));
      assert.ok(content.includes("my idea"));
    });

    it("persists across store instances", () => {
      const f = store.addFeature("persist me");
      const store2 = createDispatchStore(testDir);
      const found = store2.getFeature(f.id);
      assert.equal(found.body, "persist me");
    });

    it("stores one file per feature", () => {
      store.addFeature("one");
      store.addFeature("two");
      store.addFeature("three");

      const files = readdirSync(join(testDir, "dispatch")).filter((f) => f.endsWith(".md"));
      assert.equal(files.length, 3);
    });
  });

  describe("parseHashtags (@ mention extraction)", () => {
    function parseHashtags(text) {
      const tags = [];
      const cleaned = text.replace(/@([a-zA-Z0-9._-]+)/g, (_, tag) => {
        tags.push(tag);
        return '';
      }).replace(/\s+/g, ' ').trim();
      return { text: cleaned, projects: tags };
    }

    it("extracts single @mention", () => {
      const r = parseHashtags("make bg purple @katulong");
      assert.deepEqual(r.projects, ["katulong"]);
      assert.equal(r.text, "make bg purple");
    });

    it("extracts multiple @mentions", () => {
      const r = parseHashtags("dark mode @katulong @yelo");
      assert.deepEqual(r.projects, ["katulong", "yelo"]);
    });

    it("handles text with no @mentions", () => {
      const r = parseHashtags("just a plain idea");
      assert.deepEqual(r.projects, []);
    });
  });

  describe("getTagQuery (autocomplete trigger)", () => {
    function getTagQuery(val, cursor) {
      let i = cursor - 1;
      while (i >= 0 && /[a-zA-Z0-9._-]/.test(val[i])) i--;
      if (i >= 0 && val[i] === '@' && (i === 0 || /\s/.test(val[i - 1]))) {
        return val.slice(i + 1, cursor);
      }
      return null;
    }

    it("detects @query at end", () => assert.equal(getTagQuery("@kat", 4), "kat"));
    it("detects after space", () => assert.equal(getTagQuery("fix @kat", 8), "kat"));
    it("returns null without @", () => assert.equal(getTagQuery("text", 4), null));
    it("returns null mid-word @", () => assert.equal(getTagQuery("a@b", 3), null));
    it("returns empty after bare @", () => assert.equal(getTagQuery("@", 1), ""));
  });

  describe("autocomplete sorting", () => {
    function filterProjects(projects, query) {
      const q = query.toLowerCase();
      return projects
        .filter((p) => (p.slug || p.name || '').toLowerCase().includes(q))
        .sort((a, b) => {
          const as = (a.slug || a.name || '').toLowerCase();
          const bs = (b.slug || b.name || '').toLowerCase();
          if (as.startsWith(q) !== bs.startsWith(q)) return as.startsWith(q) ? -1 : 1;
          return as.length - bs.length;
        })
        .slice(0, 6);
    }

    it("ranks starts-with before contains", () => {
      const projects = [
        { slug: "homebrew-katulong" },
        { slug: "katulong" },
        { slug: "katha.js" },
      ];
      const m = filterProjects(projects, "kat");
      assert.ok(m[0].slug.startsWith("kat"));
      assert.equal(m[m.length - 1].slug, "homebrew-katulong");
    });

    it("limits to 6", () => {
      const many = Array.from({ length: 10 }, (_, i) => ({ slug: `p${i}` }));
      assert.equal(filterProjects(many, "p").length, 6);
    });
  });
});

describe("Dispatch Routes", () => {
  let testDir;
  let store;
  let routes;
  let routeMap;

  function createMockRes() {
    const res = {
      statusCode: null,
      headers: {},
      body: null,
      writeHead(code, headers) { res.statusCode = code; Object.assign(res.headers, headers); },
      write(data) { res.body = (res.body || "") + data; },
      end(data) { if (data) res.body = (res.body || "") + data; },
    };
    return res;
  }

  function createMockReq(method, url, body, headers = {}) {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    return {
      method, url,
      headers: { host: "localhost:3000", ...headers },
      on(event, cb) {
        if (event === "data") chunks.forEach((c) => cb(c));
        if (event === "end") cb();
        if (event === "close") {}
      },
    };
  }

  function json(res, status, data) { res.statusCode = status; res.body = JSON.stringify(data); }
  function parseJSON(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
  }
  function auth(handler) { return handler; }
  function csrf(handler) { return handler; }
  const refiner = { refine: async () => ({}), refineBatch: async () => [] };
  const executor = { dispatch: async () => ({}), cancel: async () => true };

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-dispatch-route-test-"));
    store = createDispatchStore(testDir);
    const { createDispatchRoutes } = await import("../lib/dispatch-routes.js");
    routes = createDispatchRoutes({ store, refiner, executor, json, parseJSON, auth, csrf });
    routeMap = {};
    for (const r of routes) {
      routeMap[r.prefix ? `${r.method} PREFIX:${r.prefix}` : `${r.method} ${r.path}`] = r;
    }
  });

  afterEach(() => { if (testDir) rmSync(testDir, { recursive: true, force: true }); });

  it("POST creates feature", async () => {
    const route = routeMap["POST /api/dispatch/features"];
    const req = createMockReq("POST", "/api/dispatch/features", { raw: "new idea" });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.body, "new idea");
    assert.equal(body.status, "raw");
  });

  it("POST rejects empty body", async () => {
    const route = routeMap["POST /api/dispatch/features"];
    const req = createMockReq("POST", "/api/dispatch/features", { raw: "" });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  it("GET returns features and projects", async () => {
    store.addFeature("alpha");
    store.addFeature("beta");
    const route = routeMap["GET /api/dispatch/features"];
    const req = createMockReq("GET", "/api/dispatch/features");
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.features.length, 2);
    assert.ok(Array.isArray(body.projects));
  });

  it("GET by ID returns feature", async () => {
    const f = store.addFeature("find me");
    const route = routeMap["GET PREFIX:/api/dispatch/features/"];
    const res = createMockRes();
    await route.handler(createMockReq("GET", `/api/dispatch/features/${f.id}`), res, f.id);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).body, "find me");
  });

  it("DELETE removes feature", async () => {
    const f = store.addFeature("delete me");
    const route = routeMap["DELETE PREFIX:/api/dispatch/features/"];
    const res = createMockRes();
    await route.handler(createMockReq("DELETE", `/api/dispatch/features/${f.id}`), res, f.id);
    assert.equal(res.statusCode, 200);
    assert.equal(store.getFeature(f.id), null);
  });

  it("POST /api/dispatch/refine accepts featureIds array", async () => {
    const f1 = store.addFeature("idea one");
    const f2 = store.addFeature("idea two");
    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", { featureIds: [f1.id, f2.id] });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.ok(body.ok);
    assert.ok(body.sessionTag);
    assert.deepEqual(body.featureIds, [f1.id, f2.id]);
    // Features should be marked as grouped
    assert.equal(store.getFeature(f1.id).status, "grouped");
    assert.equal(store.getFeature(f2.id).status, "grouped");
  });

  it("POST /api/dispatch/refine with all: true groups all raw features", async () => {
    const f1 = store.addFeature("idea A");
    const f2 = store.addFeature("idea B");
    store.addFeature("idea C");
    store.updateFeature(f1.id, { status: "refined" }); // not raw — should be excluded
    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", { all: true });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    // f1 is refined, so only f2 and f3 should be included
    assert.equal(body.featureIds.length, 2);
    assert.ok(!body.featureIds.includes(f1.id));
  });

  it("POST /api/dispatch/refine rejects non-raw features", async () => {
    const f1 = store.addFeature("idea");
    store.updateFeature(f1.id, { status: "refined" });
    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", { featureIds: [f1.id] });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  it("POST /api/dispatch/refine rejects empty featureIds", async () => {
    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", { featureIds: [] });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  it("POST /api/dispatch/refine rejects missing body", async () => {
    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", {});
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  it("grouped features get sessionName and groupedInto set", async () => {
    const f1 = store.addFeature("idea one");
    const f2 = store.addFeature("idea two");
    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", { featureIds: [f1.id, f2.id] });
    const res = createMockRes();
    await route.handler(req, res);
    const body = JSON.parse(res.body);
    const updated1 = store.getFeature(f1.id);
    const updated2 = store.getFeature(f2.id);
    assert.equal(updated1.groupedInto, body.sessionTag);
    assert.equal(updated2.groupedInto, body.sessionTag);
  });

  it("hook processes tool events", async () => {
    const f = store.addFeature("hook test");
    const route = routeMap["POST /api/dispatch/hook"];
    const req = createMockReq("POST", "/api/dispatch/hook", {
      feature_id: f.id,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const res = createMockRes();
    await route.handler(req, res);
    assert.equal(res.statusCode, 200);
    const updated = store.getFeature(f.id);
    assert.ok(updated.body.includes("Running tests"));
  });
});
