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
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import {
  isServerRunning,
  readServerInfo,
  getServerBaseUrl,
  SERVER_INFO_PATH,
  SERVER_PID_PATH,
} from "../lib/cli/process-manager.js";

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

  it("server.json takes priority over a real listener on the default port", () => {
    // Even if a katulong dev server happens to be running on the default
    // port (common on developer machines), the explicit info file wins.
    writeFileSync(
      SERVER_INFO_PATH,
      JSON.stringify({ pid: ALIVE_PID, port: FAKE_PORT, host: "127.0.0.1" }),
      { encoding: "utf-8" },
    );
    const url = getServerBaseUrl();
    assert.equal(url, `http://localhost:${FAKE_PORT}`);
  });

  it("returns a parseable http://localhost:<port> URL when nothing is set", () => {
    delete process.env.KATULONG_PORT;
    const url = getServerBaseUrl();
    assert.match(url, /^http:\/\/localhost:\d+$/);
  });
});
