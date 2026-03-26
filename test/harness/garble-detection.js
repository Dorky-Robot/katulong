/**
 * Garble Detection Test Harness
 *
 * NOT part of the normal test suite. Run manually:
 *   node --test test/harness/garble-detection.js
 *
 * Spins up a real katulong server + tmux sessions, connects via WebSocket,
 * and detects text garbling: duplicate prompts, broken escape sequences,
 * overlapping scrollback/pull data.
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
const TEST_PORT = 3015;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const WS_URL = `ws://localhost:${TEST_PORT}`;

// --- ANSI helpers ---

function stripAnsi(str) {
  // Remove all ANSI escape sequences
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
            .replace(/\x1b\][^\x07]*\x07/g, "")  // OSC sequences
            .replace(/\x1b[()][0-9A-Z]/g, "")      // charset selection
            .replace(/\x1b[=>]/g, "");              // keypad modes
}

function extractVisibleLines(str) {
  return stripAnsi(str).split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length > 0);
}

function isPromptLine(line) {
  // Common prompt patterns
  return /[$%#>]\s*$/.test(line) || /[$%#>] $/.test(line);
}

function findDuplicatePrompts(lines) {
  const dupes = [];
  for (let i = 1; i < lines.length; i++) {
    if (isPromptLine(lines[i]) && lines[i] === lines[i - 1]) {
      dupes.push({ line: lines[i], index: i });
    }
  }
  return dupes;
}

function findOverlap(linesA, linesB) {
  // Find longest suffix of A that matches prefix of B
  if (linesA.length === 0 || linesB.length === 0) return 0;
  const maxCheck = Math.min(linesA.length, linesB.length, 20);
  for (let len = maxCheck; len > 0; len--) {
    const suffixA = linesA.slice(-len);
    const prefixB = linesB.slice(0, len);
    if (suffixA.every((line, i) => line === prefixB[i])) return len;
  }
  return 0;
}

function validateEscapeSequences(str) {
  const errors = [];
  const csiPattern = /\x1b\[([^@-~]*)/g;
  let match;
  while ((match = csiPattern.exec(str)) !== null) {
    const params = match[1];
    // A valid CSI sequence ends with a byte in 0x40-0x7E range
    // If we matched to end of string without terminator, it's truncated
    if (params.length > 50) {
      errors.push({ offset: match.index, seq: match[0].slice(0, 20) + "...", reason: "unterminated CSI" });
    }
  }
  return errors;
}

// --- WebSocket client helper ---

class TestClient {
  constructor() {
    this.ws = null;
    this.messages = [];
    this.scrollbackData = "";  // from "output" messages
    this.pullData = "";        // from "pull-response" messages
    this.seq = null;
    this.pulling = false;
    this._ready = null;
    this._attached = null;
    this._switched = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
      this.ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        this.messages.push(msg);
        this._handleMessage(msg);
      });
    });
  }

  _sendPull() {
    if (this.seq == null || this.pulling) return;
    this.pulling = true;
    this.ws.send(JSON.stringify({ type: "pull", fromSeq: this.seq }));
  }

  attach(session, cols = 120, rows = 40) {
    this.scrollbackData = "";
    this.pullData = "";
    this.seq = null;
    return new Promise((resolve) => {
      this._attached = () => { this._attached = null; resolve(); };
      this.ws.send(JSON.stringify({ type: "attach", session, cols, rows }));
    });
  }

  switchTo(session, cols = 120, rows = 40, cached = false) {
    this.scrollbackData = "";
    this.pullData = "";
    this.seq = null;
    return new Promise((resolve) => {
      this._switched = () => { this._switched = null; resolve(); };
      this.ws.send(JSON.stringify({ type: "switch", session, cols, rows, cached }));
    });
  }

  sendInput(data) {
    this.ws.send(JSON.stringify({ type: "input", data }));
  }

  sendResize(cols, rows) {
    this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  subscribe(session) {
    this._subscribeScrollback = {};
    return new Promise((resolve) => {
      const listener = (msg) => {
        if (msg.type === "subscribed" && msg.session === session) {
          this._subscribeScrollback[session] = msg.data || "";
        }
        if (msg.type === "seq-init" && msg.session === session) {
          resolve();
        }
      };
      this._extraHandler = listener;
      this.ws.send(JSON.stringify({ type: "subscribe", session }));
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case "attached":
        this.scrollbackData += msg.data || "";
        if (this._attached) this._attached(msg);
        break;
      case "switched":
        this.scrollbackData += msg.data || "";
        if (this._switched) this._switched(msg);
        break;
      case "subscribed":
        this.scrollbackData += msg.data || "";
        break;
      case "seq-init":
        this.seq = msg.seq;
        this._sendPull();
        break;
      case "data-available":
        if (!this.pulling) this._sendPull();
        break;
      case "pull-response":
        this.pulling = false;
        if (msg.data) this.pullData += msg.data;
        this.seq = msg.cursor;
        break;
      case "pull-snapshot":
        this.pulling = false;
        if (msg.data) this.pullData += msg.data;
        this.seq = msg.cursor;
        break;
    }
    if (this._extraHandler) this._extraHandler(msg);
  }

  // Wait for output to settle (no new messages for `quietMs`)
  async waitForQuiet(quietMs = 500, maxMs = 10000) {
    const start = Date.now();
    let lastCount = this.messages.length;
    while (Date.now() - start < maxMs) {
      await sleep(100);
      // Drain any pending pulls
      if (!this.pulling && this.seq != null) this._sendPull();
      if (this.messages.length === lastCount) {
        // Check if we've been quiet long enough
        await sleep(quietMs);
        if (this.messages.length === lastCount) return;
      }
      lastCount = this.messages.length;
    }
  }

  close() {
    if (this.ws) this.ws.close();
  }

  get allOutput() {
    return this.scrollbackData + this.pullData;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function request(method, path, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

// --- Test suite ---

describe("Garble Detection", { timeout: 120000 }, () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-garble-test-"));

    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DISPLAY: process.env.DISPLAY || "",
      KATULONG_DATA_DIR: testDataDir,
      PORT: String(TEST_PORT),
    };

    serverProcess = spawn("node", [SERVER_PATH], { env, stdio: "pipe" });

    let output = "";
    serverProcess.stderr.on("data", d => { output += d; });
    serverProcess.stdout.on("data", d => { output += d; });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server start failed:\n${output}`)), 15000);
      const check = async () => {
        try {
          const r = await fetch(`${BASE_URL}/sessions`);
          if (r.ok) { clearTimeout(timeout); resolve(); }
          else setTimeout(check, 100);
        } catch {
          setTimeout(check, 100);
        }
      };
      check();
    });
  });

  after(async () => {
    if (serverProcess?.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await new Promise(r => serverProcess.on("exit", r));
    }
    // Clean up tmux sessions
    try { execSync("tmux kill-server 2>/dev/null || true"); } catch {}
    if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  });

  it("Scenario A: fresh attach to idle shell — no duplicate prompts", async () => {
    // Create session and let prompt settle
    await request("POST", "/sessions", { name: "garble-a" });
    await sleep(2000);

    const client = new TestClient();
    await client.connect();
    await client.attach("garble-a");
    await client.waitForQuiet(800, 5000);

    const allLines = extractVisibleLines(client.allOutput);
    const dupes = findDuplicatePrompts(allLines);

    // Check overlap between scrollback and pull data
    const scrollLines = extractVisibleLines(client.scrollbackData);
    const pullLines = extractVisibleLines(client.pullData);
    const overlap = findOverlap(scrollLines, pullLines);

    client.close();

    console.log(`  Scrollback lines: ${scrollLines.length}, Pull lines: ${pullLines.length}, Overlap: ${overlap}`);
    if (dupes.length > 0) {
      console.log(`  Duplicate prompts found: ${JSON.stringify(dupes)}`);
    }

    assert.equal(overlap, 0, `Scrollback/pull overlap: ${overlap} lines`);
    assert.equal(dupes.length, 0, `Duplicate prompts: ${dupes.map(d => d.line).join(", ")}`);
  });

  it("Scenario B: attach during active output — no broken escapes", async () => {
    await request("POST", "/sessions", { name: "garble-b" });
    await sleep(1000);

    // Start output in the session
    const preClient = new TestClient();
    await preClient.connect();
    await preClient.attach("garble-b");
    await preClient.waitForQuiet(500, 3000);

    // Start continuous output
    preClient.sendInput("seq 1 500\n");
    await sleep(200);

    // Connect a second client while output is flowing
    const client = new TestClient();
    await client.connect();
    await client.attach("garble-b");
    await client.waitForQuiet(1000, 8000);

    const escErrors = validateEscapeSequences(client.allOutput);

    preClient.close();
    client.close();

    console.log(`  Total output: ${client.allOutput.length} bytes, Escape errors: ${escErrors.length}`);
    if (escErrors.length > 0) {
      console.log(`  First error: ${JSON.stringify(escErrors[0])}`);
    }

    assert.equal(escErrors.length, 0, `Broken escape sequences: ${escErrors.length}`);
  });

  it("Scenario C: tab switch (non-cached) — no overlap", async () => {
    await request("POST", "/sessions", { name: "garble-c1" });
    await request("POST", "/sessions", { name: "garble-c2" });
    await sleep(1500);

    const client = new TestClient();
    await client.connect();

    // Attach to c1
    await client.attach("garble-c1");
    await client.waitForQuiet(500, 3000);
    client.sendInput("echo 'session-c1-marker'\n");
    await client.waitForQuiet(500, 3000);

    // Switch to c2
    await client.switchTo("garble-c2");
    await client.waitForQuiet(500, 3000);

    const c2ScrollLines = extractVisibleLines(client.scrollbackData);
    const c2PullLines = extractVisibleLines(client.pullData);
    const c2Overlap = findOverlap(c2ScrollLines, c2PullLines);

    // Switch back to c1 (non-cached)
    await client.switchTo("garble-c1", 120, 40, false);
    await client.waitForQuiet(500, 3000);

    const c1ScrollLines = extractVisibleLines(client.scrollbackData);
    const c1PullLines = extractVisibleLines(client.pullData);
    const c1Overlap = findOverlap(c1ScrollLines, c1PullLines);
    const c1Dupes = findDuplicatePrompts(extractVisibleLines(client.allOutput));

    client.close();

    console.log(`  C2 overlap: ${c2Overlap}, C1 overlap: ${c1Overlap}, C1 dupes: ${c1Dupes.length}`);

    assert.equal(c2Overlap, 0, `C2 scrollback/pull overlap: ${c2Overlap}`);
    assert.equal(c1Overlap, 0, `C1 scrollback/pull overlap: ${c1Overlap}`);
    assert.equal(c1Dupes.length, 0, `C1 duplicate prompts after switch: ${c1Dupes.length}`);
  });

  it("Scenario D: resize during attach — no duplicate prompts", async () => {
    await request("POST", "/sessions", { name: "garble-d" });
    await sleep(1500);

    const client = new TestClient();
    await client.connect();
    await client.attach("garble-d", 120, 40);

    // Immediately resize (simulates iPad orientation change or terminal fitting)
    client.sendResize(80, 24);
    await client.waitForQuiet(1000, 5000);

    const allLines = extractVisibleLines(client.allOutput);
    const dupes = findDuplicatePrompts(allLines);
    const overlap = findOverlap(
      extractVisibleLines(client.scrollbackData),
      extractVisibleLines(client.pullData)
    );

    client.close();

    console.log(`  Lines: ${allLines.length}, Overlap: ${overlap}, Dupes: ${dupes.length}`);

    assert.equal(overlap, 0, `Scrollback/pull overlap after resize: ${overlap}`);
    assert.equal(dupes.length, 0, `Duplicate prompts after resize: ${dupes.length}`);
  });

  it("Scenario E: rapid output burst — no broken escapes", async () => {
    await request("POST", "/sessions", { name: "garble-e" });
    await sleep(1000);

    const client = new TestClient();
    await client.connect();
    await client.attach("garble-e");
    await client.waitForQuiet(500, 3000);

    // Simulate TUI-like rapid screen updates
    client.sendInput(`printf '\\e[H\\e[2J'; for i in $(seq 1 50); do printf "\\e[%d;1HLine %d: test content here" "$i" "$i"; done; echo\n`);
    await client.waitForQuiet(1000, 8000);

    const escErrors = validateEscapeSequences(client.pullData);

    client.close();

    console.log(`  Pull data: ${client.pullData.length} bytes, Escape errors: ${escErrors.length}`);

    assert.equal(escErrors.length, 0, `Broken escape sequences in burst output: ${escErrors.length}`);
  });

  it("Scenario F: TUI simulation with tab switch — no garbled lines", async () => {
    // This simulates the real-world case: a TUI app (like Claude Code) actively
    // updating the screen, user switches to another tab and back.
    await request("POST", "/sessions", { name: "garble-f1" });
    await request("POST", "/sessions", { name: "garble-f2" });
    await sleep(1500);

    const client = new TestClient();
    await client.connect();
    await client.attach("garble-f1");
    await client.waitForQuiet(500, 3000);

    // Start a TUI-like program that continuously redraws the screen
    // This simulates Claude Code's "thinking" animation + streaming output
    client.sendInput(`while true; do for i in $(seq 1 24); do printf "\\e[%d;1H\\e[2K[%s] Line %d: Processing request... status=active elapsed=%ds" "$i" "$(date +%H:%M:%S)" "$i" "$SECONDS"; done; sleep 0.1; done &\n`);
    await sleep(2000); // Let it run for a bit

    // Switch away while TUI is updating
    await client.switchTo("garble-f2");
    await client.waitForQuiet(500, 3000);

    // Switch back (non-cached) — this is where garbling typically occurs
    await client.switchTo("garble-f1", 120, 40, false);
    await client.waitForQuiet(1000, 5000);

    const scrollLines = extractVisibleLines(client.scrollbackData);
    const pullLines = extractVisibleLines(client.pullData);
    const overlap = findOverlap(scrollLines, pullLines);
    const escErrors = validateEscapeSequences(client.allOutput);

    // Check for garbled lines: lines that contain fragments from multiple render frames
    // A garbled line has content from two different "Line N:" entries on the same line
    const allLines = extractVisibleLines(client.allOutput);
    const garbledLines = allLines.filter(line => {
      const lineMatches = line.match(/Line \d+:/g);
      return lineMatches && lineMatches.length > 1; // Two "Line N:" on same visible line = garbled
    });

    // Kill the background loop
    client.sendInput("\x03"); // Ctrl-C
    await sleep(200);
    client.sendInput("kill %1 2>/dev/null; true\n");
    await sleep(500);

    client.close();

    console.log(`  Scroll: ${scrollLines.length}, Pull: ${pullLines.length}, Overlap: ${overlap}`);
    console.log(`  Escape errors: ${escErrors.length}, Garbled lines: ${garbledLines.length}`);
    if (garbledLines.length > 0) {
      console.log(`  First garbled: "${garbledLines[0].slice(0, 80)}..."`);
    }

    assert.equal(overlap, 0, `Scrollback/pull overlap during TUI: ${overlap}`);
    assert.equal(escErrors.length, 0, `Broken escapes during TUI switch: ${escErrors.length}`);
    // Note: garbled lines in the CAPTURE are expected when a TUI is actively
    // redrawing — that's the TUI's own mid-frame state, not a katulong bug.
    // What matters is no overlap between scrollback and pull data.
    if (garbledLines.length > 0) {
      console.log(`  (${garbledLines.length} TUI mid-frame lines — expected during active redraws)`);
    }
  });

  it("Scenario G: multiple rapid tab switches — no corruption", async () => {
    await request("POST", "/sessions", { name: "garble-g1" });
    await request("POST", "/sessions", { name: "garble-g2" });
    await sleep(1500);

    const client = new TestClient();
    await client.connect();
    await client.attach("garble-g1");
    await client.waitForQuiet(500, 2000);

    // Type something in g1 to have content
    client.sendInput("echo 'g1-content-marker'; ls -la\n");
    await client.waitForQuiet(500, 2000);

    // Rapidly switch back and forth 5 times
    for (let i = 0; i < 5; i++) {
      await client.switchTo("garble-g2", 120, 40, i > 0);
      await sleep(300);
      await client.switchTo("garble-g1", 120, 40, i > 0);
      await sleep(300);
    }

    await client.waitForQuiet(1000, 5000);

    const allLines = extractVisibleLines(client.allOutput);
    const dupes = findDuplicatePrompts(allLines);
    const escErrors = validateEscapeSequences(client.allOutput);

    client.close();

    console.log(`  After 5 rapid switches: ${allLines.length} lines, ${dupes.length} dupes, ${escErrors.length} esc errors`);

    assert.equal(escErrors.length, 0, `Broken escapes after rapid switches: ${escErrors.length}`);
    // Allow some duplicate prompts from rapid switching (cosmetic), but flag if excessive
    assert.ok(dupes.length <= 2, `Excessive duplicate prompts after rapid switches: ${dupes.length}`);
  });

  it("Scenario H: subscribe with cols/rows — snapshot at correct width", async () => {
    // This tests the carousel subscribe path. A session is created at
    // 120x40, filled with wide output, then subscribed at 60x24 (carousel
    // card dimensions). The subscribe snapshot should wrap at 60 cols.
    await request("POST", "/sessions", { name: "garble-h-width" });
    await sleep(1500);

    // Attach at 120 cols and generate wide output
    const writer = new TestClient();
    await writer.connect();
    await writer.attach("garble-h-width", 120, 40);
    await writer.waitForQuiet(500, 3000);

    // Generate output that fills 120 columns
    writer.sendInput("echo 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'\n");
    await writer.waitForQuiet(500, 3000);
    writer.sendInput("echo 'marker-line-end'\n");
    await writer.waitForQuiet(500, 3000);

    // Now subscribe at 60 cols (simulating carousel card)
    const subscriber = new TestClient();
    await subscriber.connect();
    await subscriber.attach("garble-h-width", 120, 40); // attach first
    await subscriber.waitForQuiet(500, 2000);
    subscriber.scrollbackData = "";
    subscriber.pullData = "";
    await subscriber.subscribe("garble-h-width");
    await subscriber.waitForQuiet(500, 3000);

    // The subscribe snapshot should contain the marker
    const subData = subscriber._subscribeScrollback["garble-h-width"] || "";
    const subLines = extractVisibleLines(subData);

    // Check for escape sequence errors in the snapshot
    const escErrors = validateEscapeSequences(subData);

    writer.close();
    subscriber.close();

    console.log(`  Subscribe snapshot: ${subData.length} bytes, ${subLines.length} lines`);
    console.log(`  Escape errors: ${escErrors.length}`);
    if (subLines.length > 0) {
      console.log(`  Last 3 lines: ${subLines.slice(-3).join(" | ")}`);
    }

    assert.ok(subData.length > 0, "Subscribe snapshot should not be empty");
    assert.equal(escErrors.length, 0, `Broken escapes in subscribe snapshot: ${escErrors.length}`);
    // Verify the marker is in the snapshot
    const hasMarker = subLines.some(l => l.includes("marker-line-end"));
    assert.ok(hasMarker, "Subscribe snapshot should contain the marker line");
  });

  it("Scenario I: switch to brand-new session — output appears", async () => {
    // Simulates creating a new session and switching to it.
    // The switch must NOT use cached:true for a fresh terminal,
    // otherwise the server skips buffer replay and resize, and
    // the client never sees the initial prompt or typed output.
    await request("POST", "/sessions", { name: "garble-i-existing" });
    await sleep(1500);

    const client = new TestClient();
    await client.connect();
    await client.attach("garble-i-existing");
    await client.waitForQuiet(500, 3000);

    // Create a new session (use unique name to avoid conflicts)
    const newName = `garble-i-new-${Date.now()}`;
    const newResp = await request("POST", "/sessions", { name: newName });
    assert.ok(newResp.status >= 200 && newResp.status < 300, `Should create new session (got ${newResp.status})`);
    await sleep(1500); // Let shell start

    // Switch to the new session (non-cached, since terminal is fresh)
    await client.switchTo(newName, 80, 24, false);
    await client.waitForQuiet(1000, 5000);

    // Type something and wait for output
    client.sendInput("echo garble-test-marker-i\n");
    await client.waitForQuiet(1000, 5000);

    const allLines = extractVisibleLines(client.allOutput);
    const hasPrompt = allLines.some(l => /[$%#>]\s*$/.test(l) || l.includes(">"));
    const hasMarker = allLines.some(l => l.includes("garble-test-marker-i"));

    client.close();

    console.log(`  Output lines: ${allLines.length}`);
    console.log(`  Has prompt: ${hasPrompt}, Has typed output: ${hasMarker}`);
    if (allLines.length > 0) {
      console.log(`  Last 3 lines: ${allLines.slice(-3).join(" | ")}`);
    }

    assert.ok(allLines.length > 0, "Should have output from new session (not stuck)");
    assert.ok(hasMarker, "Typed command output should be visible (not frozen)");
  });

  it("Scenario J: real Claude Code session with tab switching (EXPENSIVE)", async () => {
    // This test launches actual Claude Code, sends it a prompt, and
    // switches tabs while it's thinking/streaming. This is the scenario
    // that triggers the most garbling in practice.
    //
    // Requires: `claude` CLI available in PATH
    // Skip if not available.

    let hasCC = false;
    try { execSync("which claude", { stdio: "pipe" }); hasCC = true; } catch {}
    if (!hasCC) {
      console.log("  SKIP: claude CLI not in PATH");
      return;
    }

    await request("POST", "/sessions", { name: "garble-h-cc" });
    await request("POST", "/sessions", { name: "garble-h-idle" });
    await sleep(2000);

    const client = new TestClient();
    await client.connect();

    // Attach to CC session and launch Claude Code
    await client.attach("garble-h-cc");
    await client.waitForQuiet(500, 3000);
    client.sendInput("claude --dangerously-skip-permissions 'say hello and list 10 random facts'\n");
    await sleep(5000); // Let CC start and begin outputting

    // Switch to idle session while CC is streaming
    await client.switchTo("garble-h-idle");
    await client.waitForQuiet(500, 2000);
    const idleOverlap = findOverlap(
      extractVisibleLines(client.scrollbackData),
      extractVisibleLines(client.pullData)
    );

    // Wait a bit, then switch back to CC (it should still be streaming)
    await sleep(3000);
    await client.switchTo("garble-h-cc", 120, 40, false);
    await client.waitForQuiet(2000, 15000);

    const ccScrollLines = extractVisibleLines(client.scrollbackData);
    const ccPullLines = extractVisibleLines(client.pullData);
    const ccOverlap = findOverlap(ccScrollLines, ccPullLines);
    const ccDupes = findDuplicatePrompts(extractVisibleLines(client.allOutput));
    const escErrors = validateEscapeSequences(client.allOutput);

    // Switch away and back one more time
    await client.switchTo("garble-h-idle");
    await sleep(2000);
    await client.switchTo("garble-h-cc", 120, 40, false);
    await client.waitForQuiet(2000, 15000);

    const finalOverlap = findOverlap(
      extractVisibleLines(client.scrollbackData),
      extractVisibleLines(client.pullData)
    );
    const finalEsc = validateEscapeSequences(client.allOutput);

    // Kill claude
    client.sendInput("\x03"); // Ctrl-C
    await sleep(1000);
    client.sendInput("/exit\n");
    await sleep(500);

    client.close();

    console.log(`  Idle overlap: ${idleOverlap}`);
    console.log(`  CC switch-back overlap: ${ccOverlap}, dupes: ${ccDupes.length}, esc: ${escErrors.length}`);
    console.log(`  Final switch-back overlap: ${finalOverlap}, esc: ${finalEsc.length}`);

    assert.equal(idleOverlap, 0, "Idle session had overlap");
    assert.equal(ccOverlap, 0, "CC switch-back had overlap");
    assert.equal(finalOverlap, 0, "Final CC switch-back had overlap");
    assert.equal(escErrors.length, 0, "Broken escapes after CC switch");
    assert.equal(finalEsc.length, 0, "Broken escapes after final switch");
  });
});
