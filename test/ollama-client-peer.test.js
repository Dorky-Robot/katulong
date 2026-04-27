/**
 * Tests the new peer-routing knobs on createOllamaClient — both the static
 * `authToken` and the dynamic `resolveEndpoint` callback. The callback is
 * what lets the running server pick up UI-driven config changes without a
 * restart, so verifying it's actually called per-request matters.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createOllamaClient } from "../lib/ollama-client.js";

function startStubOllama() {
  const requests = [];
  const server = createServer((req, res) => {
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
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

describe("createOllamaClient — peer routing", () => {
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
    const last = stub.requests.at(-1);
    assert.equal(last.headers.authorization, "Bearer static-token-xyz");
  });

  it("omits Bearer header when authToken is null", async () => {
    const client = createOllamaClient({ host: baseUrl, model: "test-model" });
    await client("hi");
    const last = stub.requests.at(-1);
    assert.equal(
      last.headers.authorization,
      undefined,
      "no Authorization header should be sent",
    );
  });

  it("calls resolveEndpoint on every request", async () => {
    let calls = 0;
    const client = createOllamaClient({
      model: "test-model",
      resolveEndpoint: () => {
        calls++;
        return { host: baseUrl, authToken: `token-${calls}` };
      },
    });
    await client("first");
    await client("second");
    assert.equal(calls, 2, "resolveEndpoint should be called on each request");
    const reqs = stub.requests.slice(-2);
    assert.equal(reqs[0].headers.authorization, "Bearer token-1");
    assert.equal(reqs[1].headers.authorization, "Bearer token-2");
  });

  it("resolveEndpoint can flip between peer and local without recreating the client", async () => {
    let mode = "local";
    const client = createOllamaClient({
      host: baseUrl, // unused while resolveEndpoint returns a host
      model: "test-model",
      authToken: "fallback-static",
      resolveEndpoint: () =>
        mode === "peer"
          ? { host: baseUrl, authToken: "peer-token" }
          : null, // null means "use static fallbacks"
    });

    await client("first");
    assert.equal(stub.requests.at(-1).headers.authorization, "Bearer fallback-static");

    mode = "peer";
    await client("second");
    assert.equal(stub.requests.at(-1).headers.authorization, "Bearer peer-token");
  });

  it("is backward-compatible: no Auth, no resolver = vanilla local call", async () => {
    const client = createOllamaClient({ host: baseUrl, model: "test-model" });
    const result = await client("hi");
    assert.equal(result, "hello world", "stream content should aggregate");
    const last = stub.requests.at(-1);
    assert.equal(last.url, "/api/chat");
    assert.equal(last.method, "POST");
    assert.equal(last.body.model, "test-model");
    assert.equal(last.body.stream, true);
  });
});
