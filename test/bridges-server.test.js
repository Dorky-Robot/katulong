/**
 * Tests for bridges/_lib/server.js — the shared HTTP proxy + bearer-auth
 * core that every bridge runs on top of. Ported from the standalone
 * ollama-bridge repo when bridges moved into katulong.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  bearerMatches,
  createBridgeServer,
  startBridgeServer,
} from "../bridges/_lib/server.js";

function startStubUpstream() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("status") === "stream") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write('{"chunk":1}\n');
        setTimeout(() => {
          res.write('{"chunk":2,"done":true}\n');
          res.end();
        }, 10);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, requests }),
    );
  });
}

describe("bearerMatches", () => {
  it("accepts an exact match", () => {
    assert.equal(bearerMatches("Bearer abc123", "abc123"), true);
  });
  it("rejects a wrong token of the same length", () => {
    assert.equal(bearerMatches("Bearer abc124", "abc123"), false);
  });
  it("rejects a wrong-length token", () => {
    assert.equal(bearerMatches("Bearer abc12", "abc123"), false);
  });
  it("rejects missing Bearer prefix", () => {
    assert.equal(bearerMatches("abc123", "abc123"), false);
  });
  it("rejects undefined header", () => {
    assert.equal(bearerMatches(undefined, "abc123"), false);
  });
});

describe("bridge server", () => {
  let stub;
  let bridge;
  let bridgePort;
  const TOKEN = "test-token-abc123-thirty-two-chars!";

  before(async () => {
    stub = await startStubUpstream();
    bridge = await startBridgeServer({
      port: 0,
      bind: "127.0.0.1",
      target: `http://127.0.0.1:${stub.port}`,
      token: TOKEN,
    });
    bridgePort = bridge.address().port;
  });

  after(() => {
    bridge.close();
    stub.server.close();
  });

  it("rejects requests without a Bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/api/tags`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "unauthorized");
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/api/tags`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(res.status, 401);
  });

  it("strips the bridge token before forwarding upstream", async () => {
    await fetch(`http://127.0.0.1:${bridgePort}/api/tags`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const last = stub.requests.at(-1);
    assert.equal(last.headers.authorization, undefined);
  });

  it("forwards POST body verbatim", async () => {
    const payload = { model: "gemma:3b", prompt: "hi" };
    await fetch(`http://127.0.0.1:${bridgePort}/api/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const last = stub.requests.at(-1);
    assert.equal(last.method, "POST");
    assert.equal(last.url, "/api/generate");
    assert.deepEqual(JSON.parse(last.body), payload);
  });

  it("streams chunked responses end-to-end", async () => {
    const res = await fetch(
      `http://127.0.0.1:${bridgePort}/api/generate?status=stream`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    const text = await res.text();
    assert.ok(text.includes('"chunk":1'));
    assert.ok(text.includes('"chunk":2'));
    assert.ok(text.includes('"done":true'));
  });

  it("returns 502 when upstream is unreachable", async () => {
    const orphan = await startBridgeServer({
      port: 0,
      bind: "127.0.0.1",
      target: "http://127.0.0.1:1",
      token: TOKEN,
    });
    const res = await fetch(`http://127.0.0.1:${orphan.address().port}/api/tags`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "upstream_unreachable");
    orphan.close();
  });
});
