import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration tests for Notes API endpoints.
 *
 * Verifies that per-session notes can be created, read, updated,
 * and deleted via the REST API, and that checkbox markdown is preserved.
 */

const TEST_PORT = 3007;
const BASE_URL = `http://localhost:${TEST_PORT}`;

describe("Notes API Integration", { concurrency: 1 }, () => {
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

  describe("GET /api/notes/:session", () => {
    it("returns empty content for nonexistent note", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/no-such-session`);
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.content, "");
    });
  });

  describe("PUT /api/notes/:session", () => {
    it("creates a note", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/test-session`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Hello\n- [ ] task one\n- [ ] task two" }),
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.ok, true);
    });

    it("persists the note for subsequent reads", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/test-session`);
      const data = await r.json();
      assert.equal(data.content, "# Hello\n- [ ] task one\n- [ ] task two");
    });

    it("updates existing note", async () => {
      await fetch(`${BASE_URL}/api/notes/test-session`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Hello\n- [x] task one\n- [ ] task two" }),
      });
      const r = await fetch(`${BASE_URL}/api/notes/test-session`);
      const data = await r.json();
      assert.equal(data.content, "# Hello\n- [x] task one\n- [ ] task two");
    });

    it("rejects non-string content", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/test-session`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: 123 }),
      });
      assert.equal(r.status, 400);
    });
  });

  describe("DELETE /api/notes/:session", () => {
    it("deletes an existing note", async () => {
      // Create
      await fetch(`${BASE_URL}/api/notes/to-delete`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "temp note" }),
      });
      // Delete
      const r = await fetch(`${BASE_URL}/api/notes/to-delete`, { method: "DELETE" });
      assert.equal(r.status, 200);
      // Verify gone
      const check = await fetch(`${BASE_URL}/api/notes/to-delete`);
      const data = await check.json();
      assert.equal(data.content, "");
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

      // Check off "fix clipboard bridge"
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

    it("supports reordering blocks", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/blocks-test`);
      const data = await r.json();
      const lines = data.content.split("\n");

      // Move last line to first
      const last = lines.pop();
      lines.unshift(last);

      await fetch(`${BASE_URL}/api/notes/blocks-test`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: lines.join("\n") }),
      });

      const verify = await fetch(`${BASE_URL}/api/notes/blocks-test`);
      const updated = await verify.json();
      assert.equal(updated.content.split("\n")[0], last);
    });

    it("supports inserting a block at an index", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/blocks-test`);
      const lines = (await r.json()).content.split("\n");

      lines.splice(1, 0, "## Priorities");

      await fetch(`${BASE_URL}/api/notes/blocks-test`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: lines.join("\n") }),
      });

      const verify = await fetch(`${BASE_URL}/api/notes/blocks-test`);
      const updated = (await verify.json()).content.split("\n");
      assert.equal(updated[1], "## Priorities");
    });

    it("supports removing a block by index", async () => {
      const r = await fetch(`${BASE_URL}/api/notes/blocks-test`);
      const lines = (await r.json()).content.split("\n");
      const countBefore = lines.length;

      lines.splice(1, 1); // remove "## Priorities"

      await fetch(`${BASE_URL}/api/notes/blocks-test`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: lines.join("\n") }),
      });

      const verify = await fetch(`${BASE_URL}/api/notes/blocks-test`);
      const updated = (await verify.json()).content.split("\n");
      assert.equal(updated.length, countBefore - 1);
      assert.ok(!updated.includes("## Priorities"));
    });
  });

  describe("session isolation", () => {
    it("notes are isolated per session", async () => {
      await fetch(`${BASE_URL}/api/notes/session-a`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "note for A" }),
      });
      await fetch(`${BASE_URL}/api/notes/session-b`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "note for B" }),
      });

      const a = await (await fetch(`${BASE_URL}/api/notes/session-a`)).json();
      const b = await (await fetch(`${BASE_URL}/api/notes/session-b`)).json();
      assert.equal(a.content, "note for A");
      assert.equal(b.content, "note for B");
    });
  });
});
