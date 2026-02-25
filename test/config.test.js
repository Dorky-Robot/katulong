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

    it("should reset instanceName to hostname when loaded value contains XSS payload", () => {
      const poisonedConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: "<script>alert(1)</script>",
        instanceIcon: "terminal-window",
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(poisonedConfig), "utf-8");

      const config = configManager.initialize();
      assert.strictEqual(config.instanceName, hostname(), "Should reset poisoned name to hostname");
    });

    it("should save reset instanceName to file when poisoned value is found", () => {
      const poisonedConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: '"><img src=x onerror=alert(1)>',
        instanceIcon: "terminal-window",
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(poisonedConfig), "utf-8");

      configManager.initialize();

      const saved = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      assert.strictEqual(saved.instanceName, hostname(), "Should persist the reset name to file");
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

    it("should reset instanceName to hostname when loaded value contains quotes", () => {
      const poisonedConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: 'name"with"quotes',
        instanceIcon: "terminal-window",
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(poisonedConfig), "utf-8");

      const config = configManager.initialize();
      assert.strictEqual(config.instanceName, hostname(), "Should reset name with quotes to hostname");
    });

    it("should save reset instanceName to file when poisoned value contains bad chars", () => {
      const poisonedConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: "bad<name>",
        instanceIcon: "terminal-window",
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(poisonedConfig), "utf-8");

      configManager.initialize();

      const saved = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      assert.strictEqual(saved.instanceName, hostname(), "Should persist the reset name to file");
    });

    it("should preserve valid instanceName from existing config", () => {
      const validConfig = {
        instanceId: "00000000-0000-0000-0000-000000000000",
        instanceName: "My Server 2.0",
        instanceIcon: "terminal-window",
        toolbarColor: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };

      writeFileSync(join(testDir, "config.json"), JSON.stringify(validConfig), "utf-8");

      const config = configManager.initialize();
      assert.strictEqual(config.instanceName, "My Server 2.0", "Should preserve valid instance name");
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

    it("should update instance name", async () => {
      await configManager.setInstanceName("My New Name");
      assert.strictEqual(configManager.getInstanceName(), "My New Name", "Instance name should be updated");
    });

    it("should trim whitespace", async () => {
      await configManager.setInstanceName("  Spaces  ");
      assert.strictEqual(configManager.getInstanceName(), "Spaces", "Should trim whitespace");
    });

    it("should update updatedAt timestamp", async () => {
      const originalUpdatedAt = configManager.config.updatedAt;

      // Wait a tiny bit to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));
      await configManager.setInstanceName("New Name");

      assert.notStrictEqual(
        configManager.config.updatedAt,
        originalUpdatedAt,
        "updatedAt should change"
      );
    });

    it("should persist to file", async () => {
      await configManager.setInstanceName("Persisted Name");

      const content = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      assert.strictEqual(content.instanceName, "Persisted Name", "Should save to file");
    });

    it("should reject empty string", async () => {
      await assert.rejects(
        async () => configManager.setInstanceName(""),
        /non-empty string/,
        "Should reject empty string"
      );
    });

    it("should reject whitespace-only string", async () => {
      await assert.rejects(
        async () => configManager.setInstanceName("   "),
        /non-empty string/,
        "Should reject whitespace-only string"
      );
    });

    it("should reject non-string values", async () => {
      await assert.rejects(
        async () => configManager.setInstanceName(123),
        /non-empty string/,
        "Should reject number"
      );

      await assert.rejects(
        async () => configManager.setInstanceName(null),
        /non-empty string/,
        "Should reject null"
      );

      await assert.rejects(
        async () => configManager.setInstanceName(undefined),
        /non-empty string/,
        "Should reject undefined"
      );
    });

    it("should reject names longer than 100 characters", async () => {
      const longName = "a".repeat(101);
      await assert.rejects(
        async () => configManager.setInstanceName(longName),
        /100 characters or less/,
        "Should reject names over 100 chars"
      );
    });

    it("should accept names exactly 100 characters", async () => {
      const name100 = "a".repeat(100);
      await configManager.setInstanceName(name100);
      assert.strictEqual(configManager.getInstanceName(), name100, "Should accept 100 char name");
    });

    it("should reject names with HTML injection characters", async () => {
      await assert.rejects(
        async () => configManager.setInstanceName('<script>alert(1)</script>'),
        /letters, digits, spaces, hyphens, underscores, and periods/,
        "Should reject HTML injection in instance name"
      );
    });

    it("should reject names with quotes", async () => {
      await assert.rejects(
        async () => configManager.setInstanceName('name"with"quotes'),
        /letters, digits, spaces, hyphens, underscores, and periods/,
        "Should reject quotes in instance name"
      );
    });

    it("should reject names with ampersands and semicolons", async () => {
      await assert.rejects(
        async () => configManager.setInstanceName("name&amp;injected"),
        /letters, digits, spaces, hyphens, underscores, and periods/,
        "Should reject ampersands in instance name"
      );
    });

    it("should reject XSS script tag payload", async () => {
      await assert.rejects(
        async () => configManager.setInstanceName("<script>alert(1)</script>"),
        /letters, digits, spaces, hyphens, underscores, and periods/,
        "Should reject XSS script tag"
      );
    });

    it("should reject HTML attribute injection payload", async () => {
      await assert.rejects(
        async () => configManager.setInstanceName('"><img src=x onerror=alert(1)>'),
        /letters, digits, spaces, hyphens, underscores, and periods/,
        "Should reject HTML injection"
      );
    });

    it("should reject names with angle brackets", async () => {
      await assert.rejects(
        async () => configManager.setInstanceName("My <Terminal>"),
        /letters, digits, spaces, hyphens, underscores, and periods/,
        "Should reject angle brackets"
      );
    });

    it("should accept names with allowed special characters", async () => {
      await configManager.setInstanceName("My Server 2.0");
      assert.strictEqual(configManager.getInstanceName(), "My Server 2.0");

      await configManager.setInstanceName("my-server_v1");
      assert.strictEqual(configManager.getInstanceName(), "my-server_v1");
    });

    it("should accept normal names with spaces", async () => {
      await configManager.setInstanceName("My Terminal");
      assert.strictEqual(configManager.getInstanceName(), "My Terminal");
    });

    it("should accept names with hyphens, underscores, and periods", async () => {
      await configManager.setInstanceName("my-server_1.0");
      assert.strictEqual(configManager.getInstanceName(), "my-server_1.0");
    });
  });

  describe("setInstanceIcon", () => {
    beforeEach(() => {
      configManager.initialize();
    });

    it("should accept valid icon names", async () => {
      await configManager.setInstanceIcon("terminal-window");
      assert.strictEqual(configManager.getInstanceIcon(), "terminal-window");

      await configManager.setInstanceIcon("code");
      assert.strictEqual(configManager.getInstanceIcon(), "code");

      await configManager.setInstanceIcon("gear");
      assert.strictEqual(configManager.getInstanceIcon(), "gear");

      await configManager.setInstanceIcon("file-text");
      assert.strictEqual(configManager.getInstanceIcon(), "file-text");
    });

    it("should reject icon names with HTML injection characters", async () => {
      await assert.rejects(
        async () => configManager.setInstanceIcon('terminal"><img src=x onerror=alert(1)'),
        /lowercase letters, digits, and hyphens/,
        "Should reject icon names with HTML injection"
      );
    });

    it("should reject icon names with uppercase letters", async () => {
      await assert.rejects(
        async () => configManager.setInstanceIcon("Terminal"),
        /lowercase letters, digits, and hyphens/,
        "Should reject uppercase letters"
      );
    });

    it("should reject icon names with spaces", async () => {
      await assert.rejects(
        async () => configManager.setInstanceIcon("terminal window"),
        /lowercase letters, digits, and hyphens/,
        "Should reject spaces"
      );
    });

    it("should reject icon names with special characters", async () => {
      await assert.rejects(
        async () => configManager.setInstanceIcon("terminal_window"),
        /lowercase letters, digits, and hyphens/,
        "Should reject underscores"
      );

      await assert.rejects(
        async () => configManager.setInstanceIcon("terminal.window"),
        /lowercase letters, digits, and hyphens/,
        "Should reject dots"
      );
    });

    it("should reject empty string", async () => {
      await assert.rejects(
        async () => configManager.setInstanceIcon(""),
        /non-empty string/,
        "Should reject empty string"
      );
    });

    it("should reject whitespace-only string", async () => {
      await assert.rejects(
        async () => configManager.setInstanceIcon("   "),
        /non-empty string/,
        "Should reject whitespace-only string"
      );
    });

    it("should reject icons longer than 50 characters", async () => {
      const longIcon = "a".repeat(51);
      await assert.rejects(
        async () => configManager.setInstanceIcon(longIcon),
        /50 characters or less/,
        "Should reject icon names over 50 chars"
      );
    });

    it("should persist to file", async () => {
      await configManager.setInstanceIcon("code");
      const content = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      assert.strictEqual(content.instanceIcon, "code", "Should save to file");
    });

    it("should trim whitespace", async () => {
      await configManager.setInstanceIcon("  code  ");
      assert.strictEqual(configManager.getInstanceIcon(), "code", "Should trim whitespace");
    });

    it("should reject non-string values", async () => {
      await assert.rejects(
        async () => configManager.setInstanceIcon(123),
        /non-empty string/,
        "Should reject number"
      );

      await assert.rejects(
        async () => configManager.setInstanceIcon(null),
        /non-empty string/,
        "Should reject null"
      );

      await assert.rejects(
        async () => configManager.setInstanceIcon(undefined),
        /non-empty string/,
        "Should reject undefined"
      );
    });

    it("should update updatedAt timestamp", async () => {
      const originalUpdatedAt = configManager.config.updatedAt;

      await new Promise(resolve => setTimeout(resolve, 10));
      await configManager.setInstanceIcon("laptop");

      assert.notStrictEqual(
        configManager.config.updatedAt,
        originalUpdatedAt,
        "updatedAt should change"
      );
    });

    it("should persist icon across config reload", async () => {
      await configManager.setInstanceIcon("laptop");

      const configManager2 = new ConfigManager(testDir);
      configManager2.initialize();
      assert.strictEqual(configManager2.getInstanceIcon(), "laptop", "Icon should persist across reload");
    });

    it("should accept icon names exactly 50 characters", async () => {
      const icon50 = "a".repeat(50);
      await configManager.setInstanceIcon(icon50);
      assert.strictEqual(configManager.getInstanceIcon(), icon50, "Should accept 50 char icon name");
    });
  });

  describe("setToolbarColor", () => {
    beforeEach(() => {
      configManager.initialize();
    });

    it("should update toolbar color", async () => {
      await configManager.setToolbarColor("blue");
      assert.strictEqual(configManager.getToolbarColor(), "blue", "Toolbar color should be updated");
    });

    it("should accept common color values", async () => {
      await configManager.setToolbarColor("default");
      assert.strictEqual(configManager.getToolbarColor(), "default");

      await configManager.setToolbarColor("red");
      assert.strictEqual(configManager.getToolbarColor(), "red");

      await configManager.setToolbarColor("blue");
      assert.strictEqual(configManager.getToolbarColor(), "blue");

      await configManager.setToolbarColor("teal-500");
      assert.strictEqual(configManager.getToolbarColor(), "teal-500");
    });

    it("should reject invalid color characters", async () => {
      await assert.rejects(
        async () => configManager.setToolbarColor("#ff0000"),
        { message: /lowercase letters, digits, and hyphens/ }
      );
      await assert.rejects(
        async () => configManager.setToolbarColor("rgb(255, 0, 0)"),
        { message: /lowercase letters, digits, and hyphens/ }
      );
    });

    it("should trim whitespace", async () => {
      await configManager.setToolbarColor("  blue  ");
      assert.strictEqual(configManager.getToolbarColor(), "blue", "Should trim whitespace");
    });

    it("should update updatedAt timestamp", async () => {
      const originalUpdatedAt = configManager.config.updatedAt;

      await new Promise(resolve => setTimeout(resolve, 10));
      await configManager.setToolbarColor("green");

      assert.notStrictEqual(
        configManager.config.updatedAt,
        originalUpdatedAt,
        "updatedAt should change"
      );
    });

    it("should persist to file", async () => {
      await configManager.setToolbarColor("purple");

      const content = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      assert.strictEqual(content.toolbarColor, "purple", "Should save to file");
    });

    it("should persist color across config reload", async () => {
      await configManager.setToolbarColor("teal");

      const configManager2 = new ConfigManager(testDir);
      configManager2.initialize();
      assert.strictEqual(configManager2.getToolbarColor(), "teal", "Color should persist across reload");
    });

    it("should reject empty string", async () => {
      await assert.rejects(
        async () => configManager.setToolbarColor(""),
        /non-empty string/,
        "Should reject empty string"
      );
    });

    it("should reject whitespace-only string", async () => {
      await assert.rejects(
        async () => configManager.setToolbarColor("   "),
        /non-empty string/,
        "Should reject whitespace-only string"
      );
    });

    it("should reject non-string values", async () => {
      await assert.rejects(
        async () => configManager.setToolbarColor(123),
        /non-empty string/,
        "Should reject number"
      );

      await assert.rejects(
        async () => configManager.setToolbarColor(null),
        /non-empty string/,
        "Should reject null"
      );

      await assert.rejects(
        async () => configManager.setToolbarColor(undefined),
        /non-empty string/,
        "Should reject undefined"
      );
    });

    it("should reject colors longer than 50 characters", async () => {
      const longColor = "a".repeat(51);
      await assert.rejects(
        async () => configManager.setToolbarColor(longColor),
        /50 characters or less/,
        "Should reject colors over 50 chars"
      );
    });

    it("should accept colors exactly 50 characters", async () => {
      const color50 = "a".repeat(50);
      await configManager.setToolbarColor(color50);
      assert.strictEqual(configManager.getToolbarColor(), color50, "Should accept 50 char color");
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
    it("should use atomic writes (temp file + rename)", async () => {
      configManager.initialize();
      await configManager.setInstanceName("Atomic Test");

      // Check that the final file exists and temp file doesn't
      const configPath = join(testDir, "config.json");
      const tempPath = join(testDir, "config.json.tmp");

      assert.ok(existsSync(configPath), "Final config file should exist");
      assert.ok(!existsSync(tempPath), "Temp file should be cleaned up");

      const content = JSON.parse(readFileSync(configPath, "utf-8"));
      assert.strictEqual(content.instanceName, "Atomic Test", "Content should be correct");
    });
  });

  describe("withLock", () => {
    beforeEach(() => {
      configManager.initialize();
    });

    it("should serialize concurrent operations", async () => {
      const order = [];

      const op1 = configManager.withLock(async () => {
        order.push("op1-start");
        await new Promise(resolve => setTimeout(resolve, 50));
        order.push("op1-end");
      });

      const op2 = configManager.withLock(async () => {
        order.push("op2-start");
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push("op2-end");
      });

      await Promise.all([op1, op2]);

      assert.deepStrictEqual(order, ["op1-start", "op1-end", "op2-start", "op2-end"],
        "Operations should run sequentially, not interleaved");
    });

    it("should continue after error in locked operation", async () => {
      // First operation throws
      await assert.rejects(
        () => configManager.withLock(async () => { throw new Error("fail"); }),
        /fail/
      );

      // Second operation should still work
      let ran = false;
      await configManager.withLock(async () => { ran = true; });
      assert.ok(ran, "Lock should recover after error");
    });
  });
});
