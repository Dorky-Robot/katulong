import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { ConfigManager } from "../lib/config.js";

describe("ConfigManager", () => {
  let testDir;
  let configManager;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-config-test-"));
    configManager = new ConfigManager(testDir);
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("initialize", () => {
    it("should create config with default instance name from hostname", () => {
      const config = configManager.initialize();

      assert.ok(config, "Config should be created");
      assert.strictEqual(config.instanceName, hostname(), "Instance name should default to hostname");
      assert.ok(config.createdAt, "Should have createdAt timestamp");
      assert.ok(config.updatedAt, "Should have updatedAt timestamp");
    });

    it("should create config.json file", () => {
      configManager.initialize();

      const configPath = join(testDir, "config.json");
      assert.ok(existsSync(configPath), "config.json should exist");

      const content = JSON.parse(readFileSync(configPath, "utf-8"));
      assert.strictEqual(content.instanceName, hostname(), "Saved instance name should match hostname");
    });

    it("should load existing config from file", () => {
      // Create existing config
      const existingConfig = {
        instanceName: "Test Instance",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(
        join(testDir, "config.json"),
        JSON.stringify(existingConfig),
        "utf-8"
      );

      const config = configManager.initialize();
      assert.strictEqual(config.instanceName, "Test Instance", "Should load existing instance name");
    });

    it("should handle corrupted config file gracefully", () => {
      // Write invalid JSON
      writeFileSync(join(testDir, "config.json"), "{ invalid json", "utf-8");

      const config = configManager.initialize();
      assert.strictEqual(config.instanceName, hostname(), "Should fall back to defaults on corruption");
    });
  });

  describe("getInstanceName", () => {
    it("should return instance name", () => {
      configManager.initialize();
      const name = configManager.getInstanceName();
      assert.strictEqual(name, hostname(), "Should return hostname");
    });

    it("should initialize if not already initialized", () => {
      const name = configManager.getInstanceName();
      assert.strictEqual(name, hostname(), "Should auto-initialize and return hostname");
    });
  });

  describe("setInstanceName", () => {
    beforeEach(() => {
      configManager.initialize();
    });

    it("should update instance name", () => {
      configManager.setInstanceName("My New Name");
      assert.strictEqual(configManager.getInstanceName(), "My New Name", "Instance name should be updated");
    });

    it("should trim whitespace", () => {
      configManager.setInstanceName("  Spaces  ");
      assert.strictEqual(configManager.getInstanceName(), "Spaces", "Should trim whitespace");
    });

    it("should update updatedAt timestamp", async () => {
      const originalUpdatedAt = configManager.config.updatedAt;

      // Wait a tiny bit to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));
      configManager.setInstanceName("New Name");

      assert.notStrictEqual(
        configManager.config.updatedAt,
        originalUpdatedAt,
        "updatedAt should change"
      );
    });

    it("should persist to file", () => {
      configManager.setInstanceName("Persisted Name");

      const content = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      assert.strictEqual(content.instanceName, "Persisted Name", "Should save to file");
    });

    it("should reject empty string", () => {
      assert.throws(
        () => configManager.setInstanceName(""),
        /non-empty string/,
        "Should reject empty string"
      );
    });

    it("should reject whitespace-only string", () => {
      assert.throws(
        () => configManager.setInstanceName("   "),
        /non-empty string/,
        "Should reject whitespace-only string"
      );
    });

    it("should reject non-string values", () => {
      assert.throws(
        () => configManager.setInstanceName(123),
        /non-empty string/,
        "Should reject number"
      );

      assert.throws(
        () => configManager.setInstanceName(null),
        /non-empty string/,
        "Should reject null"
      );

      assert.throws(
        () => configManager.setInstanceName(undefined),
        /non-empty string/,
        "Should reject undefined"
      );
    });

    it("should reject names longer than 100 characters", () => {
      const longName = "a".repeat(101);
      assert.throws(
        () => configManager.setInstanceName(longName),
        /100 characters or less/,
        "Should reject names over 100 chars"
      );
    });

    it("should accept names exactly 100 characters", () => {
      const name100 = "a".repeat(100);
      configManager.setInstanceName(name100);
      assert.strictEqual(configManager.getInstanceName(), name100, "Should accept 100 char name");
    });
  });

  describe("getConfig", () => {
    it("should return a copy of config", () => {
      configManager.initialize();
      const config = configManager.getConfig();

      // Mutate the returned config
      config.instanceName = "Modified";

      // Original should be unchanged
      assert.notStrictEqual(
        configManager.getInstanceName(),
        "Modified",
        "Should return a copy, not reference"
      );
    });

    it("should auto-initialize if needed", () => {
      const config = configManager.getConfig();
      assert.ok(config, "Should auto-initialize");
      assert.strictEqual(config.instanceName, hostname(), "Should have hostname");
    });
  });

  describe("save", () => {
    it("should use atomic writes (temp file + rename)", () => {
      configManager.initialize();
      configManager.setInstanceName("Atomic Test");

      // Check that the final file exists and temp file doesn't
      const configPath = join(testDir, "config.json");
      const tempPath = join(testDir, "config.json.tmp");

      assert.ok(existsSync(configPath), "Final config file should exist");
      assert.ok(!existsSync(tempPath), "Temp file should be cleaned up");

      const content = JSON.parse(readFileSync(configPath, "utf-8"));
      assert.strictEqual(content.instanceName, "Atomic Test", "Content should be correct");
    });
  });
});
