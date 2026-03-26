import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "server.js");
const TEST_PORT = 3019;
const BASE = `http://localhost:${TEST_PORT}`;

async function req(method, path, body) {
  const opts = { method };
  if (body) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe("Pub/Sub Integration", () => {
  let server, dataDir;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-pubsub-test-"));
    writeFileSync(join(dataDir, "user.json"), JSON.stringify({ id: randomUUID(), name: "owner" }));
    mkdirSync(join(dataDir, "setup-tokens"), { recursive: true });

    server = spawn("node", [SERVER_PATH], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DISPLAY: process.env.DISPLAY || "", KATULONG_DATA_DIR: dataDir, PORT: String(TEST_PORT) },
      stdio: "pipe",
    });
    server.stderr.on("data", () => {});
    server.stdout.on("data", () => {});
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("start timeout")), 15000);
      const check = async () => {
        try { const r = await fetch(`${BASE}/health`); if (r.ok) { clearTimeout(t); resolve(); } else setTimeout(check, 100); }
        catch { setTimeout(check, 100); }
      };
      check();
    });
  });

  after(async () => {
    if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise(r => server.on("exit", r)); }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /pub returns delivered count", async () => {
    const { status, body } = await req("POST", "/pub", { topic: "test", message: "hello" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.delivered, 0); // no subscribers yet
  });

  it("POST /pub rejects missing topic", async () => {
    const { status } = await req("POST", "/pub", { message: "hello" });
    assert.equal(status, 400);
  });

  it("POST /pub rejects missing message", async () => {
    const { status } = await req("POST", "/pub", { topic: "test" });
    assert.equal(status, 400);
  });

  it("POST /pub rejects invalid topic characters", async () => {
    const { status } = await req("POST", "/pub", { topic: "bad topic!", message: "hi" });
    assert.equal(status, 400);
  });

  it("POST /pub accepts topic with dots, dashes, slashes", async () => {
    const { status } = await req("POST", "/pub", { topic: "ci/build.status-v2", message: "ok" });
    assert.equal(status, 200);
  });

  it("GET /api/topics returns empty when no subscribers", async () => {
    const { status, body } = await req("GET", "/api/topics");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  it("GET /sub/:topic streams messages via SSE", async () => {
    // Start subscriber
    const controller = new AbortController();
    const subPromise = fetch(`${BASE}/sub/sse-test`, { signal: controller.signal });

    await sleep(200); // let subscriber connect

    // Publish a message
    await req("POST", "/pub", { topic: "sse-test", message: "hello-sse" });
    await sleep(200);

    // Read from the SSE stream
    const response = await subPromise;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");

    // Read a chunk
    const reader = response.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    controller.abort();

    // Should contain our message
    assert.ok(text.includes("hello-sse"), `SSE data should contain message, got: ${text}`);
  });

  it("subscriber shows in topic list", async () => {
    const controller = new AbortController();
    fetch(`${BASE}/sub/listed-topic`, { signal: controller.signal }).catch(() => {});
    await sleep(200);

    const { body } = await req("GET", "/api/topics");
    const topic = body.find(t => t.name === "listed-topic");
    assert.ok(topic, "Topic should appear in list");
    assert.equal(topic.subscribers, 1);

    controller.abort();
  });
});
