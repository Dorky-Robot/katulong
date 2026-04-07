/**
 * Tests for `runSmokeTest` in `lib/cli/upgrade-smoke.js`.
 *
 * The smoke-test-and-swap pattern (commit 7901ca3) prevents a bad upgrade
 * from leaving the host without a server: start the new binary on a temp
 * port, verify it works, and only then swap. The original implementation
 * only checked `/health` returning `{status: "ok"}`. That's a shallow
 * check — it catches "server crashed on startup" but misses:
 *
 *   - broken static file serving (user sees a blank page)
 *   - missing vendor bundle (login form loads but xterm.js is gone)
 *   - silent startup errors that didn't bring down the process (e.g.
 *     a WebAuthn import threw but the HTTP server still bound)
 *   - EADDRINUSE or other stderr errors that don't affect /health
 *
 * These tests exercise the failure modes by simulating each one via
 * mocked fetch + mocked log reader, so the whole smoke test runs
 * deterministically without spawning a real server.
 *
 * Related lessons:
 *   - 7901ca3: smoke-test-and-swap eliminates downtime on failed updates
 *   - 48a95b2 / a7fca64: "inert pipeline" bugs — passes unit tests, totally
 *     broken integration. End-to-end asserts are the answer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runSmokeTest } from "../lib/cli/upgrade-smoke.js";

/**
 * Build a mock fetch that returns pre-programmed responses per path.
 *
 * `routes` is a map from pathname to either:
 *   - a response descriptor: `{status, body, json}`
 *   - a function that returns a descriptor (for dynamic behavior)
 *   - `"throw"` to simulate a network error
 *
 * Paths not in the map return 404.
 */
function makeFetch(routes) {
  return async function mockFetch(url) {
    const { pathname } = new URL(url);
    const route = routes[pathname];
    if (route === undefined) {
      return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    }
    if (route === "throw") {
      throw new Error("simulated network error");
    }
    const desc = typeof route === "function" ? route() : route;
    return {
      ok: desc.status >= 200 && desc.status < 300,
      status: desc.status,
      text: async () => desc.body ?? "",
      json: async () => desc.json ?? {},
    };
  };
}

const OK_HEALTH = { status: 200, json: { status: "ok", version: "9.9.9", pid: 1234 } };
const OK_SHELL = {
  status: 200,
  body: "<!DOCTYPE html><html><head><title>Katulong</title></head><body></body></html>",
};
const OK_VENDOR = { status: 200, body: ".xterm { color: white; }" };

function allHealthyRoutes() {
  return {
    "/health": OK_HEALTH,
    "/": OK_SHELL,
    "/vendor/xterm/xterm.min.css": OK_VENDOR,
  };
}

describe("runSmokeTest — happy path", () => {
  it("passes when all endpoints return 200 and log is clean", async () => {
    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/nonexistent.log",
      fetchFn: makeFetch(allHealthyRoutes()),
      readLogFn: () => "server started\nlistening on :9999\n",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.health.version, "9.9.9");
  });

  it("passes when log file is missing (readLogFn throws)", async () => {
    // Missing log is non-fatal — just means nothing was written yet.
    // Don't block an otherwise-healthy upgrade on log unavailability.
    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/nonexistent.log",
      fetchFn: makeFetch(allHealthyRoutes()),
      readLogFn: () => { throw new Error("ENOENT"); },
    });

    assert.equal(result.ok, true);
  });

  it("enforces expectedVersion when provided", async () => {
    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(allHealthyRoutes()),
      readLogFn: () => "",
      expectedVersion: "9.9.9",
    });

    assert.equal(result.ok, true);
  });

  it("fails when health version does not match expectedVersion", async () => {
    // Catches "brew upgrade did nothing" — health returns the OLD version.
    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(allHealthyRoutes()),
      readLogFn: () => "",
      expectedVersion: "10.0.0", // doesn't match 9.9.9 in OK_HEALTH
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("version")));
  });
});

describe("runSmokeTest — /health failures", () => {
  it("fails when /health returns non-200", async () => {
    const routes = allHealthyRoutes();
    routes["/health"] = { status: 500, body: "internal error" };

    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(routes),
      readLogFn: () => "",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("/health") && f.includes("500")));
  });

  it("fails when /health body is not status:ok", async () => {
    const routes = allHealthyRoutes();
    routes["/health"] = { status: 200, json: { status: "degraded" } };

    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(routes),
      readLogFn: () => "",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("status")));
  });

  it("fails when /health throws (server unreachable)", async () => {
    const routes = allHealthyRoutes();
    routes["/health"] = "throw";

    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(routes),
      readLogFn: () => "",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("/health")));
  });
});

describe("runSmokeTest — SPA shell failures", () => {
  it("fails when GET / returns 404", async () => {
    // Catches broken static file serving — public/index.html missing or
    // the route table doesn't wire / anymore.
    const routes = allHealthyRoutes();
    routes["/"] = { status: 404 };

    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(routes),
      readLogFn: () => "",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("GET /")));
  });

  it("fails when GET / returns 200 but missing SPA shell marker", async () => {
    // Catches "route returns something, but it's the wrong content" —
    // e.g. an error page or a blank 200 from a misconfigured handler.
    const routes = allHealthyRoutes();
    routes["/"] = { status: 200, body: "<html><body>hello</body></html>" };

    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(routes),
      readLogFn: () => "",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.toLowerCase().includes("spa shell")));
  });
});

describe("runSmokeTest — vendor asset failures", () => {
  it("fails when the canonical vendor asset returns 404", async () => {
    // Catches the "self-hosted vendor bundle wasn't copied into Cellar"
    // release failure. The SPA would load but xterm.js would 404.
    const routes = allHealthyRoutes();
    routes["/vendor/xterm/xterm.min.css"] = { status: 404 };

    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(routes),
      readLogFn: () => "",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("vendor")));
  });
});

describe("runSmokeTest — log scanning", () => {
  it("fails when log contains EADDRINUSE", async () => {
    // The server bound successfully on the smoke-test port, but the log
    // still shows a prior EADDRINUSE — means startup had a port conflict
    // that resolved non-deterministically. Flaky ship risk.
    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(allHealthyRoutes()),
      readLogFn: () => "Error: listen EADDRINUSE: address already in use :::3001\n",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("EADDRINUSE")));
  });

  it("fails when log contains an unhandled rejection", async () => {
    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(allHealthyRoutes()),
      readLogFn: () => "(node:123) UnhandledPromiseRejectionWarning: boom\n",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.toLowerCase().includes("unhandled")));
  });

  it("fails when log contains a top-level Error: line", async () => {
    // Top-level "Error: ..." at the start of a line indicates a
    // top-level exception the process printed before (or while) dying.
    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(allHealthyRoutes()),
      readLogFn: () => "Error: Cannot find module './missing.js'\n    at Module.js:123\n",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("Error")));
  });

  it("ignores 'error' inside normal log messages (case-sensitive Error:)", async () => {
    // Don't fail on routine log lines that happen to mention "error" —
    // e.g. a structured logger's JSON line with {"level":"error"} or
    // a message body like "retrying on error". Only actual top-level
    // "Error: " prefixes count.
    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(allHealthyRoutes()),
      readLogFn: () =>
        '{"level":"info","msg":"retrying on error"}\n' +
        '{"level":"error","msg":"client disconnected"}\n',
    });

    assert.equal(result.ok, true, JSON.stringify(result.failures));
  });
});

describe("runSmokeTest — failure aggregation", () => {
  it("reports all failures, not just the first", async () => {
    // When multiple things are broken, callers should see all of them.
    // Don't short-circuit — the whole point is diagnostic output.
    const routes = {
      "/health": { status: 500 },
      "/": { status: 404 },
      "/vendor/xterm/xterm.min.css": { status: 404 },
    };

    const result = await runSmokeTest({
      baseUrl: "http://127.0.0.1:9999",
      logPath: "/tmp/x.log",
      fetchFn: makeFetch(routes),
      readLogFn: () => "",
    });

    assert.equal(result.ok, false);
    assert.ok(result.failures.length >= 3, `expected ≥3 failures, got ${result.failures.length}`);
  });
});
