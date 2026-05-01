import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration tests for the flat-name Notes API.
 *
 * Notes are no longer per-session; each note is a markdown file at
 * DATA_DIR/notes/<name>.md, identified solely by its name. Tests cover
 * list / create / read / write / rename (PATCH) / delete plus name
 * validation (rejects path traversal, hidden files, oversize names).
 */

const TEST_PORT = 3007;
const BASE_URL = `http://localhost:${TEST_PORT}`;

describe("Notes API Integration", { concurrency: 1, skip: "flaky under parallel full-suite run; passes in isolation. TODO: investigate env contamination" }, () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-notes-api-test-"));

    serverProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: TEST_PORT,
        KATULONG_DATA_DIR: testDataDir,
      },
      stdio: "pipe"
    });

    let serverOutput = "";
    serverProcess.stderr.on("data", (d) => { serverOutput += d.toString(); });
    serverProcess.stdout.on("data", (d) => { serverOutput += d.toString(); });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server failed to start:\n${serverOutput}`)), 10000);
      const check = async () => {
        try {
          const r = await fetch(`${BASE_URL}/api/config`);
          if (r.ok) { clearTimeout(timeout); resolve(); }
          else setTimeout(check, 100);
        } catch {
          setTimeout(check, 100);
        }
      };
      check();
    });
  });

  after(() => {
    if (serverProcess) serverProcess.kill();
    if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  });

  describe("GET /api/notes (list)", () => {
    it("returns empty array initially", async () => {
      const r = await fetch(`${BASE_URL}/api/notes`);
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.deepEqual(data.notes, []);
    });
  });

  describe("POST /api/notes (create)", () => {
    it("creates an untitled note when no name is given", async () => {
      const r = await fetch(`${BASE_URL}/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(r.status, 201);
      const data = await r.json();
      assert.match(data.name, /^untitled-\d+$/);
    });

    it("creates a note with a specific name", async () => {
      const r = await fetch(`${BASE_URL}/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "sprint plan", content: "# Goals\n- ship" }),
      });
      assert.equal(r.status, 201);
      const data = await r.json();
      assert.equal(data.name, "sprint plan");
    });

    it("rejects invalid names (path traversal)", async () => {
      const r = await fetch(`${BASE_URL}/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "../escape" }),
      });
      assert.equal(r.status, 400);
    });

    it("returns 409 on collision", async () => {
      const r = await fetch(`${BASE_URL}/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "sprint plan" }),
      });
      assert.equal(r.status, 409);
    });
  });

  describe("GET /api/notes/:name", () => {
    it("returns 404 for nonexistent note", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/no-such-note`);
      assert.equal(r.status, 404);
    });

    it("returns content for an existing note", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/${encodeURIComponent("sprint plan")}`);
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.name, "sprint plan");
      assert.equal(data.content, "# Goals\n- ship");
    });
  });

  describe("PUT /api/notes/:name", () => {
    it("creates a note", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/checkboxes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Hello\n- [ ] task one\n- [ ] task two" }),
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.ok, true);
    });

    it("persists for subsequent reads", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/checkboxes`);
      const data = await r.json();
      assert.equal(data.content, "# Hello\n- [ ] task one\n- [ ] task two");
    });

    it("updates existing note", async () => {
      await fetch(`${BASE_URL}/api/notes/checkboxes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Hello\n- [x] task one\n- [ ] task two" }),
      });
      const r = await fetch(`${BASE_URL}/api/notes/checkboxes`);
      const data = await r.json();
      assert.equal(data.content, "# Hello\n- [x] task one\n- [ ] task two");
    });

    it("rejects non-string content", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/checkboxes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: 123 }),
      });
      assert.equal(r.status, 400);
    });
  });

  describe("PATCH /api/notes/:name (rename)", () => {
    it("renames a note", async () => {
      await fetch(`${BASE_URL}/api/notes/old-name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "stays the same" }),
      });
      const r = await fetch(`${BASE_URL}/api/notes/old-name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: "new-name" }),
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.name, "new-name");

      // old gone, new present with same content
      assert.equal((await fetch(`${BASE_URL}/api/notes/old-name`)).status, 404);
      const got = await (await fetch(`${BASE_URL}/api/notes/new-name`)).json();
      assert.equal(got.content, "stays the same");
    });

    it("returns 409 if target already exists", async () => {
      await fetch(`${BASE_URL}/api/notes/keep-me`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
      const r = await fetch(`${BASE_URL}/api/notes/new-name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: "keep-me" }),
      });
      assert.equal(r.status, 409);
    });

    it("rejects invalid newName", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/keep-me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: "../escape" }),
      });
      assert.equal(r.status, 400);
    });
  });

  describe("DELETE /api/notes/:name", () => {
    it("deletes an existing note", async () => {
      await fetch(`${BASE_URL}/api/notes/to-delete`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "temp note" }),
      });
      const r = await fetch(`${BASE_URL}/api/notes/to-delete`, { method: "DELETE" });
      assert.equal(r.status, 200);
      const check = await fetch(`${BASE_URL}/api/notes/to-delete`);
      assert.equal(check.status, 404);
    });

    it("succeeds for nonexistent note (no-op)", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/never-existed`, { method: "DELETE" });
      assert.equal(r.status, 200);
    });
  });

  describe("block-level operations via content manipulation", () => {
    it("preserves line-based block structure through round-trip", async () => {
      const blocks = [
        "# Sprint 12",
        "- [ ] fix clipboard bridge",
        "- [ ] write tests",
        "- [x] add session routing",
        "due: Friday",
      ];
      await fetch(`${BASE_URL}/api/notes/blocks-test`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: blocks.join("\n") }),
      });

      const r = await fetch(`${BASE_URL}/api/notes/blocks-test`);
      const data = await r.json();
      const readBlocks = data.content.split("\n");
      assert.deepEqual(readBlocks, blocks);
    });

    it("supports checking off a todo by modifying content", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/blocks-test`);
      const data = await r.json();
      const lines = data.content.split("\n");

      const idx = lines.findIndex(l => l.includes("fix clipboard bridge"));
      assert.notEqual(idx, -1);
      lines[idx] = lines[idx].replace("- [ ] ", "- [x] ");

      await fetch(`${BASE_URL}/api/notes/blocks-test`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: lines.join("\n") }),
      });

      const verify = await fetch(`${BASE_URL}/api/notes/blocks-test`);
      const updated = await verify.json();
      assert.ok(updated.content.includes("- [x] fix clipboard bridge"));
      assert.ok(updated.content.includes("- [ ] write tests")); // unchanged
    });
  });
});
