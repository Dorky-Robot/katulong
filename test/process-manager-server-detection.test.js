/**
 * Tests for `isServerRunning`, `readServerInfo`, and `getServerBaseUrl` in
 * `lib/cli/process-manager.js`.
 *
 * Regression coverage for the bug where `katulong notify "..."` reported
 * "Server is not running" while the server was actually up. Root cause: the
 * CLI trusted `KATULONG_PORT` from the env, which can be stale in long-lived
 * tmux panes after a server restart on a different port. The fix makes
 * detection prefer the authoritative `~/.katulong/server.json` file written
 * by the live server.
 *
 * IMPORTANT — test isolation: these tests create, write, and delete
 * `server.json` / `server.pid` files. They MUST NOT touch the developer's
 * real `~/.katulong/` directory. Two layers of protection:
 *
 *   1. `node --test` runs each test file in its own subprocess by default,
 *      so the env mutation below is local to this file's process and does
 *      not affect other tests.
 *   2. The global `test/helpers/setup-env.js` helper only overrides
 *      `KATULONG_DATA_DIR` when it's unset — but developers running from
 *      inside a katulong shell already have `KATULONG_DATA_DIR=~/.katulong`
 *      exported by the server. So we force our own tmpdir BEFORE importing
 *      `process-manager.js` (which reads `envConfig.dataDir` at module load
 *      into its cached `SERVER_INFO_PATH` / `SERVER_PID_PATH`).
 *
 * The dynamic `await import()` is critical: a static top-level import would
 * be hoisted by the parser and run before the env mutation on line below,
 * even inside this same file.
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Force KATULONG_DATA_DIR to a private tmpdir before the module under test
// loads (it captures the value at import time). This overrides anything the
// shell already exported — crucial when running from inside a katulong tmux
// session, where `KATULONG_DATA_DIR=~/.katulong` is injected by the server.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "katulong-pm-test-"));
process.env.KATULONG_DATA_DIR = TEST_DATA_DIR;

const {
  isServerRunning,
  readServerInfo,
  getServerBaseUrl,
  SERVER_INFO_PATH,
  SERVER_PID_PATH,
} = await import("../lib/cli/process-manager.js");

// Belt-and-suspenders: if something imports process-manager.js via another
// path and caches a different DATA_DIR, refuse to run rather than clobber
// the real file. This should never fire given the override above.
const REAL_KATULONG_DIR = join(homedir(), ".katulong");
if (SERVER_INFO_PATH.startsWith(REAL_KATULONG_DIR)) {
  throw new Error(
    `Refusing to run: SERVER_INFO_PATH points at real data dir (${SERVER_INFO_PATH}).\n` +
    `KATULONG_DATA_DIR override did not take effect — check module load order.`,
  );
}

after(() => {
  try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function clearServerFiles() {
  for (const p of [SERVER_INFO_PATH, SERVER_PID_PATH]) {
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

const ALIVE_PID = process.pid; // current process is always running
const DEAD_PID = 999999; // very unlikely to exist; tests are best-effort here
const FAKE_PORT = 54321;

describe("readServerInfo", () => {
  beforeEach(clearServerFiles);
  afterEach(clearServerFiles);

  it("returns null when server.json does not exist", () => {
    assert.equal(readServerInfo(), null);
  });

  it("returns null when server.json is malformed", () => {
    writeFileSync(SERVER_INFO_PATH, "not json", { encoding: "utf-8" });
    assert.equal(readServerInfo(), null);
  });

  it("returns null when pid field is missing or wrong type", () => {
    writeFileSync(
      SERVER_INFO_PATH,
      JSON.stringify({ port: FAKE_PORT }),
      { encoding: "utf-8" },
    );
    assert.equal(readServerInfo(), null);
  });

  it("returns null when port field is missing", () => {
    writeFileSync(
      SERVER_INFO_PATH,
      JSON.stringify({ pid: ALIVE_PID }),
      { encoding: "utf-8" },
    );
    assert.equal(readServerInfo(), null);
  });

  it("returns null when the recorded pid is not running", () => {
    writeFileSync(
      SERVER_INFO_PATH,
      JSON.stringify({ pid: DEAD_PID, port: FAKE_PORT }),
      { encoding: "utf-8" },
    );
    assert.equal(readServerInfo(), null);
  });

  it("returns parsed info when the recorded pid is alive", () => {
    writeFileSync(
      SERVER_INFO_PATH,
      JSON.stringify({ pid: ALIVE_PID, port: FAKE_PORT, host: "127.0.0.1" }),
      { encoding: "utf-8" },
    );
    const info = readServerInfo();
    assert.deepEqual(info, {
      pid: ALIVE_PID,
      port: FAKE_PORT,
      host: "127.0.0.1",
    });
  });

  it("defaults host to 127.0.0.1 when missing", () => {
    writeFileSync(
      SERVER_INFO_PATH,
      JSON.stringify({ pid: ALIVE_PID, port: FAKE_PORT }),
      { encoding: "utf-8" },
    );
    assert.equal(readServerInfo().host, "127.0.0.1");
  });
});

describe("isServerRunning", () => {
  beforeEach(clearServerFiles);
  afterEach(clearServerFiles);

  it("uses server.json as the source of truth when present", () => {
    writeFileSync(
      SERVER_INFO_PATH,
      JSON.stringify({ pid: ALIVE_PID, port: FAKE_PORT, host: "127.0.0.1" }),
      { encoding: "utf-8" },
    );
    const status = isServerRunning();
    assert.equal(status.running, true);
    assert.equal(status.pid, ALIVE_PID);
    assert.equal(status.port, FAKE_PORT, "port must come from server.json, not env default");
    assert.equal(status.method, "info");
  });

  it("falls back to server.pid when server.json is missing", () => {
    writeFileSync(SERVER_PID_PATH, String(ALIVE_PID), { encoding: "utf-8" });
    const status = isServerRunning();
    assert.equal(status.running, true);
    assert.equal(status.pid, ALIVE_PID);
    assert.equal(status.method, "pidfile");
  });

  it("ignores stale server.json with a dead pid and falls through", () => {
    writeFileSync(
      SERVER_INFO_PATH,
      JSON.stringify({ pid: DEAD_PID, port: FAKE_PORT }),
      { encoding: "utf-8" },
    );
    // No pid file, no real server listening at envConfig.port either.
    const status = isServerRunning();
    assert.notEqual(status.method, "info");
  });
});

describe("getServerBaseUrl", () => {
  const originalEnv = process.env.KATULONG_PORT;

  beforeEach(clearServerFiles);
  afterEach(() => {
    clearServerFiles();
    if (originalEnv === undefined) {
      delete process.env.KATULONG_PORT;
    } else {
      process.env.KATULONG_PORT = originalEnv;
    }
  });

  it("uses port from server.json when present (the regression fix)", () => {
    writeFileSync(
      SERVER_INFO_PATH,
      JSON.stringify({ pid: ALIVE_PID, port: FAKE_PORT, host: "127.0.0.1" }),
      { encoding: "utf-8" },
    );
    // Simulate the bug condition: env carries a stale port from a long-dead server
    process.env.KATULONG_PORT = "63935";
    assert.equal(getServerBaseUrl(), `http://localhost:${FAKE_PORT}`);
  });

  it("falls back to KATULONG_PORT env when server.json is absent", () => {
    process.env.KATULONG_PORT = "54777";
    assert.equal(getServerBaseUrl(), "http://localhost:54777");
  });

  it("ignores malformed KATULONG_PORT and uses config default", () => {
    process.env.KATULONG_PORT = "not-a-port";
    const url = getServerBaseUrl();
    assert.match(url, /^http:\/\/localhost:\d+$/);
    assert.notEqual(url, "http://localhost:NaN");
  });

  it("returns a parseable http://localhost:<port> URL when nothing is set", () => {
    delete process.env.KATULONG_PORT;
    const url = getServerBaseUrl();
    assert.match(url, /^http:\/\/localhost:\d+$/);
  });
});
