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

    it("should reset instanceIcon to default when loaded value contains XSS payload", () => {
      const poisonedConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: "Test",
        instanceIcon: 'terminal"><img src=x onerror=alert(1)>',
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(poisonedConfig), "utf-8");

      const config = configManager.initialize();
      assert.strictEqual(config.instanceIcon, "terminal-window", "Should reset poisoned icon to default");
    });

    it("should reset instanceIcon to default when loaded value contains uppercase letters", () => {
      const poisonedConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: "Test",
        instanceIcon: "Terminal-Window",
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(poisonedConfig), "utf-8");

      const config = configManager.initialize();
      assert.strictEqual(config.instanceIcon, "terminal-window", "Should reset icon with uppercase letters to default");
    });

    it("should reset instanceIcon to default when loaded value contains spaces", () => {
      const poisonedConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: "Test",
        instanceIcon: "terminal window",
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(poisonedConfig), "utf-8");

      const config = configManager.initialize();
      assert.strictEqual(config.instanceIcon, "terminal-window", "Should reset icon with spaces to default");
    });

    it("should preserve valid instanceIcon from existing config", () => {
      const validConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: "Test",
        instanceIcon: "laptop",
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(validConfig), "utf-8");

      const config = configManager.initialize();
      assert.strictEqual(config.instanceIcon, "laptop", "Should preserve valid icon name");
    });

    it("should save reset icon to file when poisoned value is found", () => {
      const poisonedConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: "Test",
        instanceIcon: "bad<script>icon",
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(poisonedConfig), "utf-8");

      configManager.initialize();

      const saved = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      assert.strictEqual(saved.instanceIcon, "terminal-window", "Should persist the reset icon to file");
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

  describe("getInstanceId", () => {
    it("should return a UUID instance ID", () => {
      configManager.initialize();
      const id = configManager.getInstanceId();
      assert.ok(id, "Instance ID should exist");
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Should be a valid UUID");
    });

    it("should persist instance ID across restarts", () => {
      configManager.initialize();
      const id1 = configManager.getInstanceId();

      // Create a new instance and reinitialize
      const configManager2 = new ConfigManager(testDir);
      configManager2.initialize();
      const id2 = configManager2.getInstanceId();

      assert.strictEqual(id1, id2, "Instance ID should persist across restarts");
    });

    it("should generate instance ID for legacy configs without it", () => {
      // Create a config without instanceId (legacy format)
      const legacyConfig = {
        instanceName: "Legacy Instance",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(
        join(testDir, "config.json"),
        JSON.stringify(legacyConfig),
        "utf-8"
      );

      const config = configManager.initialize();
      assert.ok(config.instanceId, "Should generate instance ID for legacy config");
      assert.match(config.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Should be a valid UUID");

      // Verify it was saved
      const savedConfig = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      assert.strictEqual(savedConfig.instanceId, config.instanceId, "Instance ID should be saved to file");
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

  describe("setInstanceIcon", () => {
    beforeEach(() => {
      configManager.initialize();
    });

    it("should accept valid icon names", () => {
      configManager.setInstanceIcon("terminal-window");
      assert.strictEqual(configManager.getInstanceIcon(), "terminal-window");

      configManager.setInstanceIcon("code");
      assert.strictEqual(configManager.getInstanceIcon(), "code");

      configManager.setInstanceIcon("gear");
      assert.strictEqual(configManager.getInstanceIcon(), "gear");

      configManager.setInstanceIcon("file-text");
      assert.strictEqual(configManager.getInstanceIcon(), "file-text");
    });

    it("should reject icon names with HTML injection characters", () => {
      assert.throws(
        () => configManager.setInstanceIcon('terminal"><img src=x onerror=alert(1)'),
        /lowercase letters, digits, and hyphens/,
        "Should reject icon names with HTML injection"
      );
    });

    it("should reject icon names with uppercase letters", () => {
      assert.throws(
        () => configManager.setInstanceIcon("Terminal"),
        /lowercase letters, digits, and hyphens/,
        "Should reject uppercase letters"
      );
    });

    it("should reject icon names with spaces", () => {
      assert.throws(
        () => configManager.setInstanceIcon("terminal window"),
        /lowercase letters, digits, and hyphens/,
        "Should reject spaces"
      );
    });

    it("should reject icon names with special characters", () => {
      assert.throws(
        () => configManager.setInstanceIcon("terminal_window"),
        /lowercase letters, digits, and hyphens/,
        "Should reject underscores"
      );

      assert.throws(
        () => configManager.setInstanceIcon("terminal.window"),
        /lowercase letters, digits, and hyphens/,
        "Should reject dots"
      );
    });

    it("should reject empty string", () => {
      assert.throws(
        () => configManager.setInstanceIcon(""),
        /non-empty string/,
        "Should reject empty string"
      );
    });

    it("should reject icons longer than 50 characters", () => {
      const longIcon = "a".repeat(51);
      assert.throws(
        () => configManager.setInstanceIcon(longIcon),
        /50 characters or less/,
        "Should reject icon names over 50 chars"
      );
    });

    it("should persist to file", () => {
      configManager.setInstanceIcon("code");
      const content = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      assert.strictEqual(content.instanceIcon, "code", "Should save to file");
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
