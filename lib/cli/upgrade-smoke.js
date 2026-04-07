/**
 * Smoke-test assertions for a freshly-spawned katulong server.
 *
 * The smoke-test-and-swap pattern (commit 7901ca3) prevents a bad upgrade
 * from leaving the host without a server. The original check only hit
 * `/health` — that catches "server crashed on startup" but misses several
 * real failure modes users actually see:
 *
 *   - **Broken static file serving** — public/index.html missing from the
 *     Cellar, the route table not wiring `/` anymore, or a build step that
 *     dropped the SPA shell. /health passes, the user sees 404 on the
 *     login page.
 *
 *   - **Missing vendor bundle** — `public/vendor/` wasn't copied into the
 *     Homebrew Cellar during install. The SPA loads, but xterm.js 404s
 *     and the terminal is broken. This is exactly the "inert pipeline"
 *     class of bug from 48a95b2 — every isolated unit test passes, the
 *     system is still broken.
 *
 *   - **Silent startup errors** — a module threw during import but the
 *     HTTP server still bound. /health returns ok, but the error is
 *     sitting in the stderr log. We scan the log for known markers.
 *
 *   - **Version mismatch** — `brew upgrade` ran but didn't actually
 *     replace the binary, so /health reports the old version. Opt-in
 *     via `expectedVersion`.
 *
 * Auth-gated routes (e.g. /ws WebSocket upgrade) are NOT checked here
 * because the smoke test runs on 127.0.0.1 where `isLocalRequest()`
 * bypasses auth — any response we get doesn't prove auth is wired.
 * We rely on the unit tests in `auth-handlers.test.js` and friends to
 * catch auth regressions.
 *
 * All external calls (fetch, log reading) are dependency-injected so
 * this module can be unit-tested with no real server.
 */

import { readFileSync } from "node:fs";

/**
 * Run the full smoke test battery against a running server.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl              e.g. "http://127.0.0.1:54321"
 * @param {string} opts.logPath              path to the server's stderr log
 * @param {typeof fetch} [opts.fetchFn]      injected for tests
 * @param {(path: string) => string} [opts.readLogFn] injected for tests
 * @param {string|null} [opts.expectedVersion] if set, /health.version must equal
 * @returns {Promise<{ok: boolean, health: object|null, failures: string[]}>}
 */
export async function runSmokeTest({
  baseUrl,
  logPath,
  fetchFn = fetch,
  readLogFn = (p) => readFileSync(p, "utf-8"),
  expectedVersion = null,
}) {
  const failures = [];
  let health = null;

  // 1. /health — baseline liveness plus version assertion
  try {
    const res = await fetchFn(`${baseUrl}/health`);
    if (!res.ok) {
      failures.push(`GET /health returned ${res.status}`);
    } else {
      const data = await res.json();
      if (data?.status !== "ok") {
        failures.push(`GET /health status is "${data?.status}", expected "ok"`);
      } else if (expectedVersion && data.version !== expectedVersion) {
        failures.push(
          `GET /health version is "${data.version}", expected "${expectedVersion}"`,
        );
      } else {
        health = data;
      }
    }
  } catch (err) {
    failures.push(`GET /health threw: ${err.message}`);
  }

  // 2. GET / — SPA shell must serve with the Katulong title marker.
  // Catches broken static file serving and "route returns something but
  // it's the wrong content" cases.
  try {
    const res = await fetchFn(`${baseUrl}/`);
    if (!res.ok) {
      failures.push(`GET / returned ${res.status}`);
    } else {
      const html = await res.text();
      if (!html.includes("<title>Katulong</title>")) {
        failures.push(
          `GET / does not contain the SPA shell marker "<title>Katulong</title>"`,
        );
      }
    }
  } catch (err) {
    failures.push(`GET / threw: ${err.message}`);
  }

  // 3. One canonical vendor asset — proves the self-hosted bundle is
  // present and served. We pick xterm.min.css because:
  //   - it's the fingerprint for "did the vendor/ dir get copied"
  //   - it's a static file (no module evaluation)
  //   - it's referenced directly from public/index.html, so it's
  //     in the critical rendering path
  const vendorPath = "/vendor/xterm/xterm.min.css";
  try {
    const res = await fetchFn(`${baseUrl}${vendorPath}`);
    if (!res.ok) {
      failures.push(`GET ${vendorPath} returned ${res.status}`);
    }
  } catch (err) {
    failures.push(`GET ${vendorPath} threw: ${err.message}`);
  }

  // 4. Stderr log scan — catches silent startup errors that didn't
  // prevent the HTTP server from binding.
  try {
    const logContent = readLogFn(logPath);
    const errorPatterns = [
      { pattern: /EADDRINUSE/, label: "EADDRINUSE" },
      {
        pattern: /UnhandledPromiseRejectionWarning|unhandledRejection/i,
        label: "unhandled rejection",
      },
      // Top-of-line "Error: ..." — the Node default format for a
      // top-level thrown exception. Case-sensitive to avoid matching
      // structured log lines like {"level":"error","msg":"..."}.
      { pattern: /^Error: /m, label: "top-level Error:" },
    ];
    for (const { pattern, label } of errorPatterns) {
      if (pattern.test(logContent)) {
        failures.push(`stderr log contains ${label}`);
      }
    }
  } catch {
    // Missing log is non-fatal — maybe the server hasn't flushed
    // anything yet, or we're running in a mode that doesn't write one.
    // Don't block an otherwise-healthy upgrade on log unavailability.
  }

  return {
    ok: failures.length === 0,
    health,
    failures,
  };
}
