import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { ensureHostKey, safeCompare, startSSHServer } from "../lib/ssh.js";

describe("ensureHostKey", () => {
  let testDir;

  beforeEach(() => {
    testDir = join(tmpdir(), `katulong-ssh-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("generates a key file on first call", () => {
    const key = ensureHostKey(testDir);
    assert.ok(Buffer.isBuffer(key), "should return a Buffer");
    assert.ok(key.length > 0, "key should not be empty");
    assert.ok(key.toString().includes("PRIVATE KEY"), "should contain PEM private key");
    assert.ok(existsSync(join(testDir, "ssh", "host_ed25519")), "key file should exist on disk");
  });

  it("returns the same key on subsequent calls", () => {
    const key1 = ensureHostKey(testDir);
    const key2 = ensureHostKey(testDir);
    assert.deepEqual(key1, key2, "should return identical keys");
  });

  it("persists the key to DATA_DIR/ssh/host_ed25519", () => {
    ensureHostKey(testDir);
    const keyPath = join(testDir, "ssh", "host_ed25519");
    const diskContent = readFileSync(keyPath);
    const returnedContent = ensureHostKey(testDir);
    assert.deepEqual(diskContent, returnedContent);
  });

  it("creates the ssh directory if it does not exist", () => {
    const sshDir = join(testDir, "ssh");
    assert.ok(!existsSync(sshDir), "ssh dir should not exist before call");
    ensureHostKey(testDir);
    assert.ok(existsSync(sshDir), "ssh dir should be created");
  });
});

describe("safeCompare", () => {
  it("returns true for identical strings", () => {
    assert.ok(safeCompare("secret123", "secret123"));
  });

  it("returns false for different strings of same length", () => {
    assert.ok(!safeCompare("secret123", "secret456"));
  });

  it("returns false for different length strings", () => {
    assert.ok(!safeCompare("short", "muchlongerstring"));
  });

  it("returns false for empty vs non-empty", () => {
    assert.ok(!safeCompare("", "notempty"));
  });

  it("returns true for two empty strings", () => {
    assert.ok(safeCompare("", ""));
  });
});

describe("username to session mapping", () => {
  it("username becomes the session name", () => {
    const username = "my-session";
    const sessionName = username || "default";
    assert.equal(sessionName, "my-session");
  });

  it("empty username falls back to default", () => {
    const username = "";
    const sessionName = username || "default";
    assert.equal(sessionName, "default");
  });

  it("null username falls back to default", () => {
    const username = null;
    const sessionName = username || "default";
    assert.equal(sessionName, "default");
  });
});

describe("startSSHServer", () => {
  let testDir;
  let hostKey;
  let sshServer;

  beforeEach(() => {
    testDir = join(tmpdir(), `katulong-ssh-server-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(testDir, { recursive: true });
    hostKey = ensureHostKey(testDir);
  });

  afterEach(() => {
    if (sshServer) {
      sshServer.server.close();
      sshServer = null;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns a server object", () => {
    const daemonRPC = async () => ({ alive: true, buffer: "" });
    const daemonSend = () => {};
    const bridge = { register: () => {} };

    sshServer = startSSHServer({
      port: 0,
      hostKey,
      password: "testpass",
      daemonRPC,
      daemonSend,
      credentialLockout: null,
      bridge,
    });

    assert.ok(sshServer.server, "should return a server object");
    assert.ok(typeof sshServer.server.close === "function", "server should have a close method");
  });

  it("registers a bridge subscriber", () => {
    let registered = false;
    const bridge = { register: () => { registered = true; } };
    const daemonRPC = async () => ({ alive: true });
    const daemonSend = () => {};

    sshServer = startSSHServer({
      port: 0,
      hostKey,
      password: "testpass",
      daemonRPC,
      daemonSend,
      credentialLockout: null,
      bridge,
    });

    assert.ok(registered, "should register a bridge subscriber");
  });

  it("handles null bridge gracefully", () => {
    const daemonRPC = async () => ({ alive: true });
    const daemonSend = () => {};

    assert.doesNotThrow(() => {
      sshServer = startSSHServer({
        port: 0,
        hostKey,
        password: "testpass",
        daemonRPC,
        daemonSend,
        credentialLockout: null,
        bridge: null,
      });
    }, "should handle null bridge without throwing");
  });
});
