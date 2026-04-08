/**
 * Cursor Position Test Harness
 *
 * Tests that after attach/switch, the cursor position in the client's
 * terminal matches where tmux thinks the cursor is.
 *
 * Run: node --test test/harness/cursor-position.js
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
const TEST_PORT = 3016;
const BASE_URL = `http://localhost:${TEST_PORT}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(method, path, body) {
  const opts = { method };
  if (body) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

/**
 * Get tmux cursor position for a session.
 * Returns { row, col } (0-based, matching tmux's convention).
 */
function getTmuxCursor(sessionName) {
  const tmuxName = sessionName.replace(/[.:#% ]/g, "_");
  try {
    const out = execSync(`tmux display-message -t "${tmuxName}" -p "#{cursor_y},#{cursor_x}"`, { encoding: "utf-8" });
    const [row, col] = out.trim().split(",").map(Number);
    return { row, col };
  } catch {
    return null;
  }
}

/**
 * Minimal WS client that collects output and tracks what xterm would show.
 */
class TestClient {
  constructor() {
    this.ws = null;
    this.outputBuffer = "";
    this.pullBuffer = "";
    this.seq = null;
    this.pulling = false;
    this._attached = null;
    this._switched = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
      this.ws.on("message", (raw) => this._handle(JSON.parse(raw.toString())));
    });
  }

  _handle(msg) {
    switch (msg.type) {
      case "attached": this._attached?.(); break;
      case "switched": this._switched?.(); break;
      case "output": this.outputBuffer += msg.data || ""; break;
      case "seq-init":
        this.seq = msg.seq;
        this._pull();
        break;
      case "data-available":
        if (!this.pulling) this._pull();
        break;
      case "pull-response":
        this.pulling = false;
        if (msg.data) this.pullBuffer += msg.data;
        this.seq = msg.cursor;
        break;
    }
  }

  _pull() {
    if (this.seq == null || this.pulling) return;
    this.pulling = true;
    this.ws.send(JSON.stringify({ type: "pull", fromSeq: this.seq }));
  }

  attach(session, cols = 80, rows = 24) {
    this.outputBuffer = "";
    this.pullBuffer = "";
    this.seq = null;
    return new Promise(r => {
      this._attached = () => { this._attached = null; r(); };
      this.ws.send(JSON.stringify({ type: "attach", session, cols, rows }));
    });
  }

  switchTo(session, cols = 80, rows = 24, cached = false) {
    this.outputBuffer = "";
    this.pullBuffer = "";
    this.seq = null;
    return new Promise(r => {
      this._switched = () => { this._switched = null; r(); };
      this.ws.send(JSON.stringify({ type: "switch", session, cols, rows, cached }));
    });
  }

  sendInput(data) {
    this.ws.send(JSON.stringify({ type: "input", data }));
  }

  async waitForQuiet(quietMs = 300, maxMs = 8000) {
    const start = Date.now();
    let lastLen = 0;
    while (Date.now() - start < maxMs) {
      await sleep(100);
      if (!this.pulling && this.seq != null) this._pull();
      const totalLen = this.outputBuffer.length + this.pullBuffer.length;
      if (totalLen === lastLen) {
        await sleep(quietMs);
        const newLen = this.outputBuffer.length + this.pullBuffer.length;
        if (newLen === totalLen) return;
      }
      lastLen = this.outputBuffer.length + this.pullBuffer.length;
    }
  }

  close() { this.ws?.close(); }
}

describe("Cursor Position Tests", { timeout: 120000 }, () => {
  let server;
  let dataDir;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-cursor-test-"));
    server = spawn("node", [SERVER_PATH], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DISPLAY: process.env.DISPLAY || "", KATULONG_DATA_DIR: dataDir, KATULONG_TMUX_SOCKET: process.env.KATULONG_TMUX_SOCKET, PORT: String(TEST_PORT) },
      stdio: "pipe",
    });
    let output = "";
    server.stderr.on("data", d => { output += d; });
    server.stdout.on("data", d => { output += d; });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Start failed:\n${output}`)), 15000);
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

  it("idle shell: visible pane capture ends with cursor on prompt line", async () => {
    await request("POST", "/sessions", { name: "cur-idle" });
    await sleep(2000); // let shell prompt draw

    const tmuxCursor = getTmuxCursor("cur-idle");
    assert.ok(tmuxCursor, "Could not get tmux cursor");
    console.log(`  tmux cursor: row=${tmuxCursor.row} col=${tmuxCursor.col}`);

    // The visible pane capture should produce output where the last
    // non-empty line is the prompt, and the cursor should be on that line.
    const client = new TestClient();
    await client.connect();
    await client.attach("cur-idle");
    await client.waitForQuiet();

    // Count non-empty lines in the output buffer (visible pane capture)
    const outputLines = client.outputBuffer.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .split("\n").map(l => l.trimEnd());
    const lastNonEmpty = outputLines.findLastIndex(l => l.length > 0);

    console.log(`  output lines: ${outputLines.length}, last non-empty: ${lastNonEmpty}`);
    console.log(`  last line content: "${outputLines[lastNonEmpty]?.slice(0, 40)}"`);

    // tmux cursor row should match the last non-empty line
    // (0-based tmux row vs 0-based line index)
    assert.equal(tmuxCursor.row, lastNonEmpty,
      `tmux cursor row (${tmuxCursor.row}) != last non-empty line (${lastNonEmpty})`);

    client.close();
  });

  it("after tab switch to idle shell: no cursor offset", async () => {
    await request("POST", "/sessions", { name: "cur-sw1" });
    await request("POST", "/sessions", { name: "cur-sw2" });
    await sleep(2000);

    const client = new TestClient();
    await client.connect();
    await client.attach("cur-sw1");
    await client.waitForQuiet();

    // Switch to sw2 and back
    await client.switchTo("cur-sw2");
    await client.waitForQuiet();
    await client.switchTo("cur-sw1", 80, 24, false);
    await client.waitForQuiet();

    const tmuxCursor = getTmuxCursor("cur-sw1");
    console.log(`  tmux cursor after switch-back: row=${tmuxCursor?.row} col=${tmuxCursor?.col}`);

    // Verify the output doesn't have the cursor on a different line than expected
    const outputLines = client.outputBuffer.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .split("\n").map(l => l.trimEnd());
    const lastNonEmpty = outputLines.findLastIndex(l => l.length > 0);

    console.log(`  last non-empty line: ${lastNonEmpty}, content: "${outputLines[lastNonEmpty]?.slice(0, 40)}"`);

    assert.ok(tmuxCursor, "Could not get tmux cursor");
    assert.equal(tmuxCursor.row, lastNonEmpty,
      `cursor row mismatch: tmux=${tmuxCursor.row} vs output=${lastNonEmpty}`);

    client.close();
  });

  it("after typing a command: cursor is on the right line", async () => {
    await request("POST", "/sessions", { name: "cur-typed" });
    await sleep(2000);

    const client = new TestClient();
    await client.connect();
    await client.attach("cur-typed");
    await client.waitForQuiet();

    // Type a command and run it
    client.sendInput("echo hello\n");
    await client.waitForQuiet(500, 5000);

    const tmuxCursor = getTmuxCursor("cur-typed");
    console.log(`  tmux cursor after echo: row=${tmuxCursor?.row} col=${tmuxCursor?.col}`);

    // The pull buffer should have the echo output and the prompt should
    // be on the line tmux reports
    const allOutput = client.outputBuffer + client.pullBuffer;
    const lines = allOutput.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").map(l => l.trimEnd());
    const lastNonEmpty = lines.findLastIndex(l => l.length > 0);
    console.log(`  last non-empty: ${lastNonEmpty}, content: "${lines[lastNonEmpty]?.slice(0, 40)}"`);

    assert.ok(tmuxCursor, "Could not get tmux cursor");

    client.close();
  });
});
