/**
 * Tab Switch Duplicate Detection
 *
 * Verifies that switching tabs doesn't cause content to be duplicated.
 * The main bug: fitAll() sent resize for all sessions on every focus change,
 * triggering tmux redraws that duplicated content via the pull mechanism.
 *
 * Run: node --test test/harness/tab-switch-duplicate.js
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "../..", "server.js");
const TEST_PORT = 3017;
const BASE_URL = `http://localhost:${TEST_PORT}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(method, path, body) {
  const opts = { method };
  if (body) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

class Client {
  constructor() { this.ws = null; this.allPullData = ""; this.seq = null; this.pulling = false; this._resolve = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
      this.ws.on("message", (raw) => this._handle(JSON.parse(raw.toString())));
    });
  }
  _handle(msg) {
    if (msg.type === "attached") this._resolve.attached?.();
    if (msg.type === "switched") this._resolve.switched?.();
    if (msg.type === "seq-init") { this.seq = msg.seq; this._pull(); }
    if (msg.type === "data-available" && !this.pulling) this._pull();
    if (msg.type === "pull-response") {
      this.pulling = false;
      if (msg.data) this.allPullData += msg.data;
      this.seq = msg.cursor;
    }
  }
  _pull() {
    if (this.seq == null || this.pulling) return;
    this.pulling = true;
    this.ws.send(JSON.stringify({ type: "pull", fromSeq: this.seq }));
  }
  attach(session) {
    this.allPullData = "";
    return new Promise(r => {
      this._resolve.attached = () => { delete this._resolve.attached; r(); };
      this.ws.send(JSON.stringify({ type: "attach", session, cols: 80, rows: 24 }));
    });
  }
  switchTo(session, cached = true) {
    this.allPullData = "";
    return new Promise(r => {
      this._resolve.switched = () => { delete this._resolve.switched; r(); };
      this.ws.send(JSON.stringify({ type: "switch", session, cols: 80, rows: 24, cached }));
    });
  }
  sendInput(data) { this.ws.send(JSON.stringify({ type: "input", data })); }
  async waitQuiet(ms = 500, max = 5000) {
    const start = Date.now();
    let lastLen = 0;
    while (Date.now() - start < max) {
      await sleep(100);
      if (!this.pulling && this.seq != null) this._pull();
      const len = this.allPullData.length;
      if (len === lastLen) { await sleep(ms); if (this.allPullData.length === len) return; }
      lastLen = this.allPullData.length;
    }
  }
  close() { this.ws?.close(); }
}

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, ""); }

describe("Tab Switch Duplicate", { timeout: 60000 }, () => {
  let server, dataDir;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-dup-test-"));
    server = spawn("node", [SERVER_PATH], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DISPLAY: process.env.DISPLAY || "", KATULONG_DATA_DIR: dataDir, KATULONG_TMUX_SOCKET: process.env.KATULONG_TMUX_SOCKET, PORT: String(TEST_PORT) },
      stdio: "pipe",
    });
    server.stderr.on("data", () => {});
    server.stdout.on("data", () => {});
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("start timeout")), 15000);
      const check = async () => {
        try { const r = await fetch(`${BASE_URL}/sessions`); if (r.ok) { clearTimeout(t); resolve(); } else setTimeout(check, 100); }
        catch { setTimeout(check, 100); }
      };
      check();
    });
  });

  after(async () => {
    if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise(r => server.on("exit", r)); }
    try { execSync("tmux kill-server 2>/dev/null || true"); } catch {}
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("switching between 2 cached tabs 5 times doesn't duplicate content", async () => {
    await request("POST", "/sessions", { name: "dup-a" });
    await request("POST", "/sessions", { name: "dup-b" });
    await sleep(2000);

    const client = new Client();
    await client.connect();
    await client.attach("dup-a");
    await client.waitQuiet();

    // Type a unique marker
    client.sendInput("echo MARKER_ALPHA\n");
    await client.waitQuiet(500, 3000);

    // Count how many times the marker appears after initial command
    const initialCount = stripAnsi(client.allPullData).split("MARKER_ALPHA").length - 1;
    console.log(`  Initial marker count: ${initialCount}`);

    // Now switch back and forth 5 times
    for (let i = 0; i < 5; i++) {
      await client.switchTo("dup-b", true);
      await sleep(300);
      await client.switchTo("dup-a", true);
      await client.waitQuiet(300, 2000);
    }

    // Count markers in all pull data accumulated during switches
    const finalCount = stripAnsi(client.allPullData).split("MARKER_ALPHA").length - 1;
    console.log(`  Final marker count after 5 switches: ${finalCount}`);

    client.close();

    // The marker should not have been re-sent — pull data during cached
    // switches should be empty (no tmux redraws).
    assert.equal(finalCount, 0, `Content duplicated ${finalCount} times during cached switches`);
  });
});
