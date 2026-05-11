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

  it("re-probes higher-priority backends quickly when serving from a fallback", async () => {
    // Simulates the peer-bridge being down at first call (so we cascade
    // to local-31b), then coming back online. With the fallback-aware
    // short TTL, the next call after fallbackTtlMs should re-probe and
    // migrate back to peer-bridge.
    let bridgeReachable = false;
    const client = createOllamaClient({
      resolveBackends: () => [
        {
          name: "peer-bridge",
          host: bridgeReachable ? bridgeUrl : "http://127.0.0.1:1",
          authToken: null,
          model: "gemma4:31b",
        },
        { name: "local-31b", host: localUrl, authToken: null, model: "gemma4:31b" },
      ],
      probeTimeoutMs: 200,
      // Short TTL so the test can wait it out, with a generous 5x margin
      // on the post-expiry sleep below to absorb GC pauses on loaded CI.
      fallbackTtlMs: 50,
      probeTtlMs: 10 * 60 * 1000,
    });

    await client("first");
    assert.equal(client.getActiveBackend().name, "local-31b");

    // Bridge comes back. Within fallbackTtlMs we still trust the cached
    // fallback (no probe storm).
    bridgeReachable = true;
    const localChatsBefore = localStub.requests.filter((r) => r.url === "/api/chat").length;
    await client("second");
    assert.equal(client.getActiveBackend().name, "local-31b", "stays on fallback within TTL");
    const localChatsAfter = localStub.requests.filter((r) => r.url === "/api/chat").length;
    assert.equal(localChatsAfter, localChatsBefore + 1, "second call served by local within TTL");

    // After fallbackTtlMs expires, the next call should re-probe and find
    // the now-healthy peer-bridge. 5x the TTL to tolerate scheduler jitter.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await client("third");
    assert.equal(client.getActiveBackend().name, "peer-bridge", "migrates back once TTL expires");
    assert.ok(
      bridgeStub.requests.some((r) => r.url === "/api/chat"),
      "bridge served the third call",
    );
  });

  it("uses the long TTL when the active backend is the highest-priority one", async () => {
    // Counterpart to the fallback test: when we're already on the
    // preferred backend, fallbackTtlMs must NOT shorten the cache —
    // otherwise we'd probe-storm the happy path.
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "peer-bridge", host: bridgeUrl, authToken: null, model: "gemma4:31b" },
        { name: "local-31b",   host: localUrl,  authToken: null, model: "gemma4:31b" },
      ],
      fallbackTtlMs: 10,
      probeTtlMs: 10 * 60 * 1000,
    });
    await client("first");
    assert.equal(client.getActiveBackend().name, "peer-bridge");
    const probesAfterFirst = bridgeStub.requests.filter((r) => r.url === "/api/tags").length;
    // Wait well past fallbackTtlMs so the assertion below is a true
    // negative — if the index-0 backend were incorrectly short-TTL'd,
    // this delay would force a re-probe.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client("second");
    const probesAfterSecond = bridgeStub.requests.filter((r) => r.url === "/api/tags").length;
    assert.equal(probesAfterFirst, 1, "first call probes once");
    assert.equal(probesAfterSecond, 1, "preferred backend is not re-probed on the short TTL");
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

  it("backs off after a complete cascade failure (no probe storm)", async () => {
    let resolveCalls = 0;
    const client = createOllamaClient({
      resolveBackends: () => {
        resolveCalls++;
        return [{ name: "p", host: "http://127.0.0.1:1", authToken: null, model: "x" }];
      },
      probeTimeoutMs: 200,
      failTtlMs: 60_000,
    });
    // First call exhausts the cascade and sets the backoff.
    await assert.rejects(() => client("first"));
    assert.equal(resolveCalls, 1);
    // Second call hits the backoff branch — no resolveBackends, no probe.
    await assert.rejects(() => client("second"), /failure backoff/);
    assert.equal(resolveCalls, 1, "should not have re-resolved during backoff");
  });

  it("invalidate() clears the failure backoff too", async () => {
    let resolveCalls = 0;
    const client = createOllamaClient({
      resolveBackends: () => {
        resolveCalls++;
        return [{ name: "p", host: "http://127.0.0.1:1", authToken: null, model: "x" }];
      },
      probeTimeoutMs: 200,
      failTtlMs: 60_000,
    });
    await assert.rejects(() => client("first"));
    client.invalidate();
    // After invalidate, the backoff is gone and the next call probes again.
    await assert.rejects(() => client("second"));
    assert.equal(resolveCalls, 2);
  });

  it("skips the just-failed backend when fast-path falls through", async () => {
    // A stub that answers /api/tags but 500s on /api/chat. Becomes the
    // cached active (probe says yes), then the fast path's chat call
    // fails. The slow path must NOT re-probe-and-call the broken
    // backend — should jump straight to the healthy one.
    let chatCallsToBroken = 0;
    const brokenStub = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ models: [{ name: "gemma4:31b" }] }));
      }
      chatCallsToBroken++;
      res.writeHead(500);
      res.end("nope");
    });
    await new Promise((resolve) => brokenStub.listen(0, "127.0.0.1", resolve));
    const brokenUrl = `http://127.0.0.1:${brokenStub.address().port}`;

    try {
      const client = createOllamaClient({
        resolveBackends: () => [
          { name: "broken",   host: brokenUrl, authToken: null, model: "gemma4:31b" },
          { name: "local-31b", host: localUrl, authToken: null, model: "gemma4:31b" },
        ],
      });
      // First call: probe broken (ok), chat broken (fails), probe local (ok),
      // chat local (works). One chat hit on broken, one chat hit on local.
      await client("first");
      assert.equal(client.getActiveBackend().name, "local-31b");
      assert.equal(chatCallsToBroken, 1, "broken should have been tried exactly once");
      // Second call hits the fast path on local-31b — broken not touched.
      await client("second");
      assert.equal(chatCallsToBroken, 1, "broken must not be retried after fast-path success");
    } finally {
      brokenStub.close();
    }
  });

  it("getActiveBackend does NOT expose the host (foot-gun guard)", async () => {
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "p", host: bridgeUrl, authToken: null, model: "gemma4:31b" },
      ],
    });
    await client("hi");
    const active = client.getActiveBackend();
    assert.equal(active.name, "p");
    assert.equal(active.model, "gemma4:31b");
    assert.equal(
      active.host,
      undefined,
      "host must not appear in getActiveBackend's return — could leak peer URL or embedded creds",
    );
  });
});

/**
 * Stub for the new queued backend protocol. Answers /api/tags for the
 * cascade probe, /enqueue with a fake hash, and /jobs/:hash with a
 * configurable script (queued → running → done) so a test can verify
 * the poll loop actually loops.
 */
function startStubBridge({
  availableModels = ["gemma4:31b"],
  // statuses is consumed in order; once exhausted, "done" is returned forever.
  statuses = ["done"],
  result = { message: { role: "assistant", content: "hello world" } },
} = {}) {
  const requests = [];
  let pollIdx = 0;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const parsed = body ? safeParse(body) : null;
      requests.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });

      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: availableModels.map((name) => ({ name })) }));
        return;
      }

      if (req.method === "POST" && req.url === "/enqueue") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ hash: "a".repeat(64), status: "queued" }));
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/jobs/")) {
        const status = statuses[Math.min(pollIdx, statuses.length - 1)] || "done";
        pollIdx += 1;

        const payload =
          status === "done"
            ? { status, result }
            : status === "error"
              ? { status, error: "stub error" }
              : { status };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, requests }),
    );
  });
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

describe("createOllamaClient — queued backend", () => {
  let stub;
  let url;

  beforeEach(async () => {
    stub = await startStubBridge();
    url = `http://127.0.0.1:${stub.port}`;
  });
  afterEach(() => stub.server.close());

  it("enqueues with the wrapped {endpoint, body} shape and forces stream:false", async () => {
    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "bridge", host: url, authToken: "tok-32-chars-or-more-padding-pad", kind: "queued", model: "gemma4:31b" },
      ],
    });
    await client("hi", { systemPrompt: "be brief" });

    const enq = stub.requests.find((r) => r.url === "/enqueue");
    assert.equal(enq.method, "POST");
    assert.equal(enq.headers.authorization, "Bearer tok-32-chars-or-more-padding-pad");
    assert.equal(enq.body.endpoint, "/api/chat");
    assert.equal(enq.body.body.model, "gemma4:31b");
    assert.equal(enq.body.body.stream, false);
    assert.deepEqual(enq.body.body.messages, [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("polls /jobs/:hash until status is done and returns message.content", async () => {
    stub.server.close();
    stub = await startStubBridge({ statuses: ["queued", "running", "done"] });
    url = `http://127.0.0.1:${stub.port}`;

    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "bridge", host: url, authToken: null, kind: "queued", model: "gemma4:31b" },
      ],
    });
    const result = await client("hi");
    assert.equal(result, "hello world");

    // Each non-terminal poll should have been observed.
    const polls = stub.requests.filter((r) => r.url.startsWith("/jobs/"));
    assert.equal(polls.length, 3, "should poll three times: queued, running, done");
  });

  it("throws when the bridge reports status: error", async () => {
    stub.server.close();
    stub = await startStubBridge({ statuses: ["error"] });
    url = `http://127.0.0.1:${stub.port}`;

    const client = createOllamaClient({
      resolveBackends: () => [
        { name: "bridge", host: url, authToken: null, kind: "queued", model: "gemma4:31b" },
      ],
    });
    await assert.rejects(() => client("hi"), /queued backend job failed/);
  });

  it("falls through to the next backend when /enqueue returns non-2xx", async () => {
    // First backend's /enqueue replies 503; should cascade to local.
    const failingStub = await startStubBridge();
    failingStub.server.close();
    const failingServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "gemma4:31b" }] }));
        return;
      }
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "queue_full" }));
    });
    await new Promise((r) => failingServer.listen(0, "127.0.0.1", r));
    const failingUrl = `http://127.0.0.1:${failingServer.address().port}`;

    const localStub = await startStubOllama({ availableModels: ["gemma4:31b"] });
    const localUrl = `http://127.0.0.1:${localStub.port}`;

    try {
      const client = createOllamaClient({
        resolveBackends: () => [
          { name: "bridge", host: failingUrl, authToken: null, kind: "queued", model: "gemma4:31b" },
          { name: "local",  host: localUrl,   authToken: null,                     model: "gemma4:31b" },
        ],
      });
      const result = await client("hi");
      assert.equal(result, "hello world");
    } finally {
      failingServer.close();
      localStub.server.close();
    }
  });
});
