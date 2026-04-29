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
      if (url.searchParams.get("status") === "sse-silent") {
        // SSE upstream that stays silent for the requested duration before
        // sending a single visible event, then ends. Used to verify the
        // bridge injects keepalive comments while upstream is quiet.
        const silentMs = Number(url.searchParams.get("ms") || "200");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // Flush headers so the bridge enters its silent-SSE keepalive
        // phase before we send any real bytes (matches real LLM upstream
        // behavior where headers land immediately and tokens come later).
        res.flushHeaders();
        const t = setTimeout(() => {
          if (!res.writableEnded) {
            res.write('data: {"x":1}\n\n');
            res.end();
          }
        }, silentMs);
        res.on("close", () => clearTimeout(t));
        return;
      }
      if (url.searchParams.get("status") === "sse-error-mid") {
        // Sends one SSE event then abruptly destroys the socket — used
        // to confirm the bridge cleans up the keepalive timer and tears
        // down the response without crashing on a write-after-error.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        res.write('data: first\n\n');
        setTimeout(() => res.destroy(), 30);
        return;
      }
      if (url.searchParams.get("status") === "sse-stream") {
        // Continuously emits an SSE event every `intervalMs` (default 10ms)
        // until the response closes. Used to catch the race where the
        // bridge data handler must guard against `res` already being
        // destroyed by a client-side abort.
        const intervalMs = Number(url.searchParams.get("interval") || "10");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        let n = 0;
        const i = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(i);
            return;
          }
          res.write(`data: ${n++}\n\n`);
        }, intervalMs);
        res.on("close", () => clearInterval(i));
        return;
      }
      if (url.searchParams.get("status") === "sse-cached") {
        // Upstream tries to set Cache-Control: public, max-age=60 on an
        // SSE response. Bridge must override to no-cache, no-store —
        // intermediate caches cannot be allowed to capture a live stream.
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "public, max-age=60",
        });
        res.flushHeaders();
        setTimeout(() => {
          if (!res.writableEnded) {
            res.write('data: ok\n\n');
            res.end();
          }
        }, 20);
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
      logger: () => {}, // suppress test-time noise
      keepaliveMs: 50,
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

  it("injects SSE keepalive comments while upstream is silent", async () => {
    // Upstream stays quiet for 200ms, then sends one event. With
    // keepaliveMs=50 the bridge should emit at least one `: keepalive`
    // SSE comment before the real event arrives.
    const res = await fetch(
      `http://127.0.0.1:${bridgePort}/api/sse?status=sse-silent&ms=200`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    // Belt-and-suspenders header for nginx-shaped intermediaries.
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    const text = await res.text();
    assert.match(text, /:\s*keepalive/);
    // Real event still arrives.
    assert.match(text, /data:\s*\{"x":1\}/);
  });

  it("does NOT inject keepalive on non-SSE responses", async () => {
    const res = await fetch(`http://127.0.0.1:${bridgePort}/api/tags`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const text = await res.text();
    assert.doesNotMatch(text, /keepalive/);
    // Should not have added the buffering hint to a non-SSE response.
    assert.equal(res.headers.get("x-accel-buffering"), null);
  });

  it("tears down upstream and the keepalive timer on client disconnect", async () => {
    // Spin up a private bridge so we can capture logger events without
    // racing other tests. Stub uses a 5s upstream silence so we can
    // observe the disconnect cleanup *before* upstream would have ended
    // on its own.
    const events = [];
    const probe = await startBridgeServer({
      port: 0,
      bind: "127.0.0.1",
      target: `http://127.0.0.1:${stub.port}`,
      token: TOKEN,
      logger: (e) => events.push(e),
      keepaliveMs: 50,
    });
    const probePort = probe.address().port;

    const ac = new AbortController();
    const promise = fetch(
      `http://127.0.0.1:${probePort}/api/sse?status=sse-silent&ms=5000`,
      { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    try {
      await promise;
    } catch (_e) {
      /* expected */
    }
    // Wait long enough that, if the bridge had failed to destroy
    // upstream, the data handler would have fired write-after-destroy
    // and emitted an upstream_error event.
    await new Promise((r) => setTimeout(r, 250));
    // ECONNRESET is the expected consequence of our deliberate
    // upstreamReq.destroy() — upstream's socket gets RST'd. The bug we
    // want to catch is the data handler writing to an already-destroyed
    // `res`, which surfaces as ERR_STREAM_DESTROYED or
    // ERR_STREAM_WRITE_AFTER_END.
    const writeAfterDestroy = events.filter(
      (e) =>
        e.event === "upstream_error" &&
        /ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END/.test(e.code || ""),
    );
    assert.equal(
      writeAfterDestroy.length,
      0,
      `expected no write-after-destroy errors after client disconnect, got: ${JSON.stringify(writeAfterDestroy)}`,
    );
    probe.close();
  });

  it("destroys the upstream connection when the client aborts mid-stream", async () => {
    // Direct observation of the leak fix: spin up a private stub that
    // counts how many chunks it has *sent*. After the bridge call, we
    // sample the counter, abort the client, wait, then sample again.
    // If the bridge correctly calls upstreamReq.destroy() on
    // res.on('close'), the stub's response fires its own 'close' event
    // and stops the chunk loop within one tick. The counter delta
    // post-abort should be small (last in-flight chunk + close
    // propagation). Without the fix, the stub keeps streaming for the
    // full wait window — the counter delta will be 25–30+.
    let chunkCount = 0;
    const trackingStub = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      const i = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(i);
          return;
        }
        chunkCount++;
        res.write(`data: ${chunkCount}\n\n`);
      }, 8);
      res.on("close", () => clearInterval(i));
    });
    await new Promise((r) => trackingStub.listen(0, "127.0.0.1", r));
    const probe = await startBridgeServer({
      port: 0,
      bind: "127.0.0.1",
      target: `http://127.0.0.1:${trackingStub.address().port}`,
      token: TOKEN,
      logger: () => {},
      keepaliveMs: 50,
    });

    const ac = new AbortController();
    const promise = fetch(
      `http://127.0.0.1:${probe.address().port}/sse`,
      { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    try {
      await promise;
    } catch (_e) {
      /* expected */
    }
    const countAtAbort = chunkCount;
    // Wait significantly longer than the 8ms tick — without the fix,
    // 30 more chunks would arrive in this window. With the fix, the
    // stub's res.on('close') fires within 1–2 ticks of abort and the
    // counter freezes.
    await new Promise((r) => setTimeout(r, 250));
    const delta = chunkCount - countAtAbort;
    assert.ok(
      delta <= 5,
      `upstream not torn down on client abort: stub sent ${delta} more chunks after client gave up (countAtAbort=${countAtAbort}, finalCount=${chunkCount})`,
    );

    probe.close();
    trackingStub.close();
  });

  it("forces no-cache, no-store on SSE responses, overriding upstream Cache-Control", async () => {
    const res = await fetch(
      `http://127.0.0.1:${bridgePort}/api/sse?status=sse-cached`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    // Must NOT preserve the upstream's public/max-age caching directive
    // for a live stream.
    const cc = res.headers.get("cache-control");
    assert.match(cc, /no-cache/);
    assert.match(cc, /no-store/);
    assert.doesNotMatch(cc, /public/);
    assert.doesNotMatch(cc, /max-age/);
    await res.text(); // drain
  });

  it("survives upstream destroying the socket mid-stream", async () => {
    const events = [];
    const probe = await startBridgeServer({
      port: 0,
      bind: "127.0.0.1",
      target: `http://127.0.0.1:${stub.port}`,
      token: TOKEN,
      logger: (e) => events.push(e),
      keepaliveMs: 50,
    });
    const res = await fetch(
      `http://127.0.0.1:${probe.address().port}/api/sse?status=sse-error-mid`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(res.status, 200);
    try {
      await res.text();
    } catch (_e) {
      /* truncated streams may surface as a fetch read error; tolerable */
    }
    // Give the bridge a tick to settle its cleanup.
    await new Promise((r) => setTimeout(r, 80));

    // The bridge must NOT have thrown a write-after-destroy error inside
    // the data handler — that would indicate the bug from Round 1 has
    // regressed. We tolerate the upstream's own ECONNRESET / aborted
    // signal, which is the legitimate "upstream gave up" telemetry.
    const writeAfterDestroy = events.filter(
      (e) =>
        e.event === "upstream_error" &&
        /ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END/.test(e.code || ""),
    );
    assert.equal(
      writeAfterDestroy.length,
      0,
      `expected no write-after-destroy errors, got: ${JSON.stringify(writeAfterDestroy)}`,
    );
    probe.close();
  });

  it("rejects garbage keepaliveMs values by falling back to the default", async () => {
    // NaN / negative values would otherwise cause sub-millisecond ticks
    // (CPU burn). The defensive clamp inside createBridgeServer should
    // map them to the default. We exercise the *SSE* path here so the
    // setInterval is actually constructed under the bad value — without
    // the clamp, setInterval(fn, NaN) treats the delay as 1ms and pegs
    // a CPU. The test would then time out or hang; with the clamp it
    // completes promptly.
    const probe = await startBridgeServer({
      port: 0,
      bind: "127.0.0.1",
      target: `http://127.0.0.1:${stub.port}`,
      token: TOKEN,
      logger: () => {},
      keepaliveMs: NaN,
    });
    const res = await fetch(
      `http://127.0.0.1:${probe.address().port}/api/sse?status=sse-silent&ms=80`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const body = await res.text();
    // The response body distinguishes clamped vs. unclamped behavior:
    //   - With the clamp: keepaliveMs = 15000ms default. 80ms upstream
    //     silence is way under threshold → 0 keepalive frames written.
    //   - Without the clamp: setInterval(fn, NaN) → 1ms ticks. The
    //     threshold check `Date.now() - lastByteAt < NaN` is always
    //     false → keepalive frame written on every tick → ~80 frames.
    // Anything above a small handful indicates the clamp was bypassed.
    const keepaliveCount = (body.match(/:\s*keepalive/g) || []).length;
    assert.ok(
      keepaliveCount < 5,
      `clamp regression: expected <5 keepalive frames in 80ms, got ${keepaliveCount}`,
    );
    probe.close();
  });

  it("returns 502 when upstream is unreachable", async () => {
    const orphan = await startBridgeServer({
      port: 0,
      bind: "127.0.0.1",
      target: "http://127.0.0.1:1",
      token: TOKEN,
      logger: () => {},
    });
    const res = await fetch(`http://127.0.0.1:${orphan.address().port}/api/tags`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "upstream_unreachable");
    // Don't leak upstream URL or syscall details — the body should NOT
    // include `detail`, the upstream hostname, or "ECONNREFUSED".
    assert.equal(body.detail, undefined);
    assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"));
    orphan.close();
  });

  it("strips hop-by-hop and forwarding headers", async () => {
    await fetch(`http://127.0.0.1:${bridgePort}/api/tags`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "X-Forwarded-For": "1.2.3.4",
        "X-Real-IP": "5.6.7.8",
        Connection: "close",
      },
    });
    const last = stub.requests.at(-1);
    assert.equal(last.headers["x-forwarded-for"], undefined);
    assert.equal(last.headers["x-real-ip"], undefined);
    // Note: node's http client adds its own `Connection: keep-alive`
    // when no value is set, so we can't assert connection is absent —
    // only that the client's "close" value didn't propagate.
    assert.notEqual(last.headers["connection"], "close");
  });

  it("invokes the logger on auth failure with the source address", async () => {
    const events = [];
    const probe = await startBridgeServer({
      port: 0,
      bind: "127.0.0.1",
      target: `http://127.0.0.1:${stub.port}`,
      token: TOKEN,
      logger: (e) => events.push(e),
    });
    await fetch(`http://127.0.0.1:${probe.address().port}/api/tags`);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "auth_failure");
    assert.equal(events[0].reason, "missing_header");
    assert.match(events[0].remoteAddress, /127\.0\.0\.1|::1|::ffff:127/);
    probe.close();
  });
});
