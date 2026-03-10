import { describe, it } from "node:test";
import assert from "node:assert/strict";
import envConfig from "../lib/env-config.js";

describe("env-config", () => {
  it("exports a frozen object", () => {
    assert.ok(Object.isFrozen(envConfig), "config must be frozen (immutable)");
  });

  it("has expected keys", () => {
    const expectedKeys = [
      "port", "bindHost", "dataDir",
      "shell", "nodeEnv", "logLevel", "drainTimeout", "home",
    ];
    for (const key of expectedKeys) {
      assert.ok(key in envConfig, `config must have key: ${key}`);
    }
  });

  it("port is a number", () => {
    assert.equal(typeof envConfig.port, "number");
    assert.ok(envConfig.port > 0, "port must be positive");
  });

  it("dataDir is a non-empty string", () => {
    assert.equal(typeof envConfig.dataDir, "string");
    assert.ok(envConfig.dataDir.length > 0, "dataDir must be non-empty");
  });

  it("shell is a non-empty string", () => {
    assert.equal(typeof envConfig.shell, "string");
    assert.ok(envConfig.shell.length > 0, "shell must be non-empty");
  });

  it("nodeEnv is a non-empty string", () => {
    assert.equal(typeof envConfig.nodeEnv, "string");
    assert.ok(envConfig.nodeEnv.length > 0, "nodeEnv must be non-empty");
  });

  it("logLevel is a non-empty string", () => {
    assert.equal(typeof envConfig.logLevel, "string");
    assert.ok(envConfig.logLevel.length > 0, "logLevel must be non-empty");
  });

  it("drainTimeout is a number", () => {
    assert.equal(typeof envConfig.drainTimeout, "number");
    assert.ok(envConfig.drainTimeout > 0, "drainTimeout must be positive");
  });

  it("home is a string or null", () => {
    assert.ok(
      envConfig.home === null || typeof envConfig.home === "string",
      "home must be a string or null"
    );
  });

  it("defaults: port is 3001 when PORT env var is not set", () => {
    // Only assert default when PORT is not explicitly overridden in the environment
    if (!process.env.PORT) {
      assert.equal(envConfig.port, 3001);
    }
  });

  it("defaults: drainTimeout is 30000 when DRAIN_TIMEOUT is not set", () => {
    if (!process.env.DRAIN_TIMEOUT) {
      assert.equal(envConfig.drainTimeout, 30000);
    }
  });

  it("config cannot be mutated (frozen)", () => {
    assert.throws(() => {
      "use strict";
      envConfig.port = 9999;
    }, TypeError);
  });
});
