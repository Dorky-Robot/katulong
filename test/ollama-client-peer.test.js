/**
 * Tests for createOllamaClient: backward-compat single-backend mode AND
 * the new cascade (resolveBackends) that probes a list of backends in
 * priority order.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createOllamaClient } from "../lib/ollama-client.js";

/**
 * Start a stub Ollama that answers both /api/tags (probe) and /api/chat.
 *
 * `availableModels` controls which models /api/tags reports — the cascade
 * probe needs the requested model to appear in the list, otherwise it
 * skips to the next backend.
 */
function startStubOllama({ availableModels = ["test-model"] } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      requests.push({ url: req.url, method: req.method, headers: req.headers });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: availableModels.map((name) => ({ name })) }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"),
      });
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write('{"message":{"content":"hello"},"done":false}\n');
      res.write('{"message":{"content":" world"},"done":true}\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, requests }),
    );
  });
}

describe("createOllamaClient — single-backend (backward-compat)", () => {
  let stub;
  let baseUrl;

  before(async () => {
    stub = await startStubOllama();
    baseUrl = `http://127.0.0.1:${stub.port}`;
  });
  after(() => stub.server.close());

  it("includes Bearer header when authToken is set statically", async () => {
    const client = createOllamaClient({
      host: baseUrl,
      model: "test-model",
      authToken: "static-token-xyz",
    });
    await client("hi");
    const lastChat = stub.requests.findLast((r) => r.url === "/api/chat");
    assert.equal(lastChat.headers.authorization, "Bearer static-token-xyz");
  });

  it("omits Bearer header when authToken is null", async () => {
    const client = createOllamaClient({ host: baseUrl, model: "test-model" });
    await client("hi");
    const lastChat = stub.requests.findLast((r) => r.url === "/api/chat");
    assert.equal(lastChat.headers.authorization, undefined);
  });

  it("aggregates the streamed response body", async () => {
    const client = createOllamaClient({ host: baseUrl, model: "test-model" });
    const result = await client("hi");
    assert.equal(result, "hello world");
  });

  it("resolveEndpoint can flip between peer and local without recreating the client", async () => {
    let mode = "local";
    const client = createOllamaClient({
      host: baseUrl,
      model: "test-model",
      authToken: "fallback-static",
      resolveEndpoint: () =>
        mode === "peer"
          ? { host: baseUrl, authToken: "peer-token" }
          : null,
    });

    await client("first");
    assert.equal(
      stub.requests.findLast((r) => r.url === "/api/chat").headers.authorization,
      "Bearer fallback-static",
    );

    mode = "peer";
    client.invalidate(); // force re-probe so the new resolveEndpoint is sampled
    await client("second");
    assert.equal(
      stub.requests.findLast((r) => r.url === "/api/chat").headers.authorization,
      "Bearer peer-token",
    );
  });
});

describe("createOllamaClient — cascade (resolveBackends)", () => {
  let bridgeStub, localStub;
  let bridgeUrl, localUrl;

  beforeEach(async () => {
    bridgeStub = await startStubOllama({ availableModels: ["gemma4:31b"] });
    localStub = await startStubOllama({ availableModels: ["gemma4:31b", "gemma4:31b-cloud"] });
    bridgeUrl = `http://127.0.0.1:${bridgeStub.port}`;
    localUrl = `http://127.0.0.1:${localStub.port}`;
  });
  afterEach(() => {
    bridgeStub?.server.close();
    localStub?.server.close();
    bridgeStub = null;
    localStub = null;
  });

  it("picks the first backend in the list when it has the requested model", async () => {
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "peer-bridge", host: bridgeUrl, authToken: "tok", model: "gemma4:31b" },
        { name: "local-31b",   host: localUrl,  authToken: null,  model: "gemma4:31b" },
      ],
    });
    await client("hi");
    const active = client.getActiveBackend();
    assert.equal(active.name, "peer-bridge");
    // Bridge stub got the chat call, local stub did not.
    assert.ok(bridgeStub.requests.some((r) => r.url === "/api/chat"));
    assert.ok(!localStub.requests.some((r) => r.url === "/api/chat"));
  });

  it("falls through to the next backend when the first lacks the model", async () => {
    // Tier 1 is configured for gemma4:99b — the bridge stub doesn't have
    // it, so /api/tags will not include it and the probe fails.
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "peer-bridge", host: bridgeUrl, authToken: "tok", model: "nonexistent-model" },
        { name: "local-31b",   host: localUrl,  authToken: null,  model: "gemma4:31b" },
      ],
    });
    await client("hi");
    assert.equal(client.getActiveBackend().name, "local-31b");
    // Probe ran against bridge but no chat call was made there.
    assert.ok(bridgeStub.requests.some((r) => r.url === "/api/tags"));
    assert.ok(!bridgeStub.requests.some((r) => r.url === "/api/chat"));
    assert.ok(localStub.requests.some((r) => r.url === "/api/chat"));
  });

  it("falls through to the next backend when the first is unreachable", async () => {
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "peer-bridge", host: "http://127.0.0.1:1", authToken: null, model: "gemma4:31b" },
        { name: "local-31b",   host: localUrl, authToken: null, model: "gemma4:31b" },
      ],
      probeTimeoutMs: 500,
    });
    await client("hi");
    assert.equal(client.getActiveBackend().name, "local-31b");
  });

  it("falls through from gemma4:31b → gemma4:31b-cloud when local doesn't have :31b", async () => {
    // Local-31b is "available" structurally but the Ollama daemon only
    // has the cloud variant pulled. Probe filters on model name in
    // /api/tags, so this works as expected.
    const onlyCloudStub = await startStubOllama({ availableModels: ["gemma4:31b-cloud"] });
    const onlyCloudUrl = `http://127.0.0.1:${onlyCloudStub.port}`;
    try {
      const client = createOllamaClient({
        resolveBackends: () => [
          { name: "local-31b",   host: onlyCloudUrl, authToken: null, model: "gemma4:31b" },
          { name: "local-cloud", host: onlyCloudUrl, authToken: null, model: "gemma4:31b-cloud" },
        ],
      });
      await client("hi");
      assert.equal(client.getActiveBackend().name, "local-cloud");
    } finally {
      onlyCloudStub.server.close();
    }
  });

  it("caches the active backend across calls (no re-probe within TTL)", async () => {
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "peer-bridge", host: bridgeUrl, authToken: null, model: "gemma4:31b" },
      ],
    });
    await client("first");
    const probesAfterFirst = bridgeStub.requests.filter((r) => r.url === "/api/tags").length;
    await client("second");
    const probesAfterSecond = bridgeStub.requests.filter((r) => r.url === "/api/tags").length;
    assert.equal(probesAfterFirst, 1, "first call should probe");
    assert.equal(probesAfterSecond, 1, "second call should reuse the cached active");
  });

  it("invalidate() forces the next call to re-probe", async () => {
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "peer-bridge", host: bridgeUrl, authToken: null, model: "gemma4:31b" },
      ],
    });
    await client("first");
    client.invalidate();
    await client("second");
    const probes = bridgeStub.requests.filter((r) => r.url === "/api/tags").length;
    assert.equal(probes, 2, "invalidate should force a re-probe");
  });

  it("getActiveBackend returns null when nothing has been probed yet", () => {
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "peer-bridge", host: bridgeUrl, authToken: null, model: "gemma4:31b" },
      ],
    });
    assert.equal(client.getActiveBackend(), null);
  });

  it("throws a clear error when no backend is reachable", async () => {
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "p", host: "http://127.0.0.1:1", authToken: null, model: "x" },
      ],
      probeTimeoutMs: 300,
    });
    await assert.rejects(() => client("hi"), /no backend reachable/);
  });
});
