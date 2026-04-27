/**
 * Tests for bridges/_lib/config-loader.js — per-bridge config storage
 * and the resolveBridge() function that overlays config on manifest.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  bridgeConfigPath,
  loadBridgeConfig,
  writeBridgeConfig,
  resolveBridge,
  generateToken,
} from "../bridges/_lib/config-loader.js";

const MANIFEST = Object.freeze({
  name: "ollama",
  port: 11435,
  target: "http://127.0.0.1:11434",
});

describe("bridge config loader", () => {
  let dataDir;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "bridges-config-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("bridgeConfigPath puts each bridge in its own dir", () => {
    const path = bridgeConfigPath(dataDir, "ollama");
    assert.ok(path.endsWith(["bridges", "ollama", "config.json"].join(sep)));
  });

  it("loadBridgeConfig returns null when no file exists", () => {
    assert.equal(loadBridgeConfig(dataDir, "ollama"), null);
  });

  it("writeBridgeConfig persists a token", () => {
    writeBridgeConfig(dataDir, "ollama", { token: "x".repeat(64) });
    const config = loadBridgeConfig(dataDir, "ollama");
    assert.equal(config.token.length, 64);
  });

  it("writeBridgeConfig preserves existing fields on partial updates", () => {
    writeBridgeConfig(dataDir, "ollama", { token: "first-token-".repeat(4) });
    writeBridgeConfig(dataDir, "ollama", { port: 12000 });
    const config = loadBridgeConfig(dataDir, "ollama");
    assert.equal(config.port, 12000);
    assert.ok(config.token.startsWith("first-token-"));
  });

  it("writeBridgeConfig drops null fields rather than persisting them", () => {
    writeBridgeConfig(dataDir, "ollama", { token: "a".repeat(64), port: 12000 });
    writeBridgeConfig(dataDir, "ollama", { port: null });
    const config = loadBridgeConfig(dataDir, "ollama");
    assert.equal(config.port, undefined);
    assert.equal(config.token.length, 64);
  });

  it("config file is written mode 0600", () => {
    writeBridgeConfig(dataDir, "ollama", { token: "a".repeat(64) });
    const path = bridgeConfigPath(dataDir, "ollama");
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  });

  it("loadBridgeConfig surfaces malformed JSON with the path in the message", () => {
    writeBridgeConfig(dataDir, "ollama", { token: "a".repeat(64) });
    const path = bridgeConfigPath(dataDir, "ollama");
    // Corrupt the file
    const buf = readFileSync(path);
    writeFileSync(path, buf.toString().replace("{", "{["));
    assert.throws(
      () => loadBridgeConfig(dataDir, "ollama"),
      /malformed/,
    );
  });
});

describe("resolveBridge", () => {
  let dataDir;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "bridges-resolve-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("requires a token to be configured", () => {
    assert.throws(
      () => resolveBridge({ manifest: MANIFEST, dataDir }),
      /no token configured/,
    );
  });

  it("returns the manifest defaults when only token is configured", () => {
    writeBridgeConfig(dataDir, "ollama", { token: "a".repeat(64) });
    const resolved = resolveBridge({ manifest: MANIFEST, dataDir });
    assert.equal(resolved.port, MANIFEST.port);
    assert.equal(resolved.target, MANIFEST.target);
    assert.equal(resolved.bind, "127.0.0.1");
    assert.equal(resolved.token, "a".repeat(64));
  });

  it("config overrides win over manifest defaults", () => {
    writeBridgeConfig(dataDir, "ollama", {
      token: "a".repeat(64),
      port: 12000,
      bind: "0.0.0.0",
      target: "http://192.168.1.5:11434",
    });
    const resolved = resolveBridge({ manifest: MANIFEST, dataDir });
    assert.equal(resolved.port, 12000);
    assert.equal(resolved.bind, "0.0.0.0");
    assert.equal(resolved.target, "http://192.168.1.5:11434");
  });

  it("rejects an invalid port", () => {
    writeBridgeConfig(dataDir, "ollama", { token: "a".repeat(64), port: 70000 });
    assert.throws(
      () => resolveBridge({ manifest: MANIFEST, dataDir }),
      /invalid port/,
    );
  });

  it("rejects a non-http(s) target", () => {
    writeBridgeConfig(dataDir, "ollama", {
      token: "a".repeat(64),
      target: "ftp://nope",
    });
    assert.throws(
      () => resolveBridge({ manifest: MANIFEST, dataDir }),
      /must start with http/,
    );
  });
});

describe("generateToken", () => {
  it("returns a 64-char hex string (256 bits of entropy)", () => {
    const t = generateToken();
    assert.equal(t.length, 64);
    assert.match(t, /^[0-9a-f]+$/);
  });

  it("returns a different value each call", () => {
    assert.notEqual(generateToken(), generateToken());
  });
});
