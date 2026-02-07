import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseShortcuts,
  serializeShortcuts,
  loadShortcuts,
  saveShortcuts,
  validateShortcut,
  ShortcutsSuccess,
  ShortcutsFailure,
} from "../lib/shortcuts.js";

describe("parseShortcuts", () => {
  it("parses valid shortcuts JSON", () => {
    const json = JSON.stringify([
      { label: "Clear", keys: "ctrl+l" },
      { label: "List", keys: "ctrl+d" },
    ]);

    const result = parseShortcuts(json);

    assert.ok(result instanceof ShortcutsSuccess);
    assert.equal(result.shortcuts.length, 2);
    assert.equal(result.shortcuts[0].label, "Clear");
    assert.equal(result.shortcuts[1].keys, "ctrl+d");
  });

  it("accepts empty array", () => {
    const result = parseShortcuts("[]");

    assert.ok(result instanceof ShortcutsSuccess);
    assert.deepEqual(result.shortcuts, []);
  });

  it("returns failure for invalid JSON", () => {
    const result = parseShortcuts("not json");

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "parse-error");
  });

  it("returns failure when shortcuts is not an array", () => {
    const result = parseShortcuts('{"label": "test"}');

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "invalid-format");
    assert.match(result.message, /must be an array/i);
  });

  it("returns failure when entry is not an object", () => {
    const result = parseShortcuts('["string", "another"]');

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "invalid-entry");
    assert.match(result.message, /index 0.*not an object/i);
  });

  it("returns failure when entry missing label", () => {
    const json = JSON.stringify([
      { keys: "ctrl+l" },
    ]);

    const result = parseShortcuts(json);

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "missing-label");
    assert.match(result.message, /index 0.*missing.*label/i);
  });

  it("returns failure when entry missing keys", () => {
    const json = JSON.stringify([
      { label: "Clear" },
    ]);

    const result = parseShortcuts(json);

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "missing-keys");
    assert.match(result.message, /index 0.*missing.*keys/i);
  });

  it("returns failure when label is not a string", () => {
    const json = JSON.stringify([
      { label: 123, keys: "ctrl+l" },
    ]);

    const result = parseShortcuts(json);

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "missing-label");
  });

  it("returns failure when keys is not a string", () => {
    const json = JSON.stringify([
      { label: "Clear", keys: 123 },
    ]);

    const result = parseShortcuts(json);

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "missing-keys");
  });

  it("validates all entries before returning success", () => {
    const json = JSON.stringify([
      { label: "Clear", keys: "ctrl+l" },
      { label: "List" }, // missing keys
    ]);

    const result = parseShortcuts(json);

    assert.ok(result instanceof ShortcutsFailure);
    assert.match(result.message, /index 1/);
  });
});

describe("serializeShortcuts", () => {
  it("converts shortcuts to formatted JSON with newline", () => {
    const shortcuts = [
      { label: "Clear", keys: "ctrl+l" },
      { label: "List", keys: "ctrl+d" },
    ];

    const result = serializeShortcuts(shortcuts);

    assert.match(result, /\[\n/);
    assert.match(result, /"label": "Clear"/);
    assert.match(result, /"keys": "ctrl\+d"/);
    assert.ok(result.endsWith("\n"));
  });

  it("handles empty array", () => {
    const result = serializeShortcuts([]);

    assert.equal(result, "[]\n");
  });
});

describe("loadShortcuts", () => {
  const testDir = join(tmpdir(), `shortcuts-test-${Date.now()}`);
  const testFile = join(testDir, "shortcuts.json");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads valid shortcuts from file", () => {
    const shortcuts = [
      { label: "Clear", keys: "ctrl+l" },
      { label: "List", keys: "ctrl+d" },
    ];
    writeFileSync(testFile, JSON.stringify(shortcuts, null, 2));

    const result = loadShortcuts(testFile);

    assert.ok(result instanceof ShortcutsSuccess);
    assert.equal(result.shortcuts.length, 2);
    assert.equal(result.shortcuts[0].label, "Clear");
  });

  it("returns empty array when file does not exist", () => {
    const result = loadShortcuts(join(testDir, "nonexistent.json"));

    assert.ok(result instanceof ShortcutsSuccess);
    assert.deepEqual(result.shortcuts, []);
  });

  it("returns failure when file contains invalid JSON", () => {
    writeFileSync(testFile, "not json");

    const result = loadShortcuts(testFile);

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "parse-error");
  });

  it("returns failure when file contains invalid shortcuts structure", () => {
    writeFileSync(testFile, '{"not": "array"}');

    const result = loadShortcuts(testFile);

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "invalid-format");
  });
});

describe("saveShortcuts", () => {
  const testDir = join(tmpdir(), `shortcuts-test-${Date.now()}`);
  const testFile = join(testDir, "shortcuts.json");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves valid shortcuts to file", () => {
    const shortcuts = [
      { label: "Clear", keys: "ctrl+l" },
      { label: "List", keys: "ctrl+d" },
    ];

    const result = saveShortcuts(testFile, shortcuts);

    assert.ok(result instanceof ShortcutsSuccess);
    assert.ok(existsSync(testFile));

    // Verify file contents
    const loaded = loadShortcuts(testFile);
    assert.ok(loaded instanceof ShortcutsSuccess);
    assert.equal(loaded.shortcuts.length, 2);
  });

  it("returns failure when shortcuts are invalid", () => {
    const invalidShortcuts = [
      { label: "Clear" }, // missing keys
    ];

    const result = saveShortcuts(testFile, invalidShortcuts);

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "missing-keys");
  });

  it("does not create file when validation fails", () => {
    const invalidShortcuts = [
      { keys: "ctrl+l" }, // missing label
    ];

    saveShortcuts(testFile, invalidShortcuts);

    assert.ok(!existsSync(testFile));
  });

  it("returns failure when directory does not exist", () => {
    const badPath = join(testDir, "nonexistent-dir", "shortcuts.json");
    const shortcuts = [{ label: "Test", keys: "ctrl+t" }];

    const result = saveShortcuts(badPath, shortcuts);

    assert.ok(result instanceof ShortcutsFailure);
    assert.equal(result.reason, "file-error");
  });
});

describe("validateShortcut", () => {
  it("returns valid for well-formed shortcut", () => {
    const shortcut = { label: "Clear", keys: "ctrl+l" };

    const result = validateShortcut(shortcut);

    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("returns invalid when shortcut is not an object", () => {
    const result = validateShortcut("string");

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("must be an object")));
  });

  it("returns invalid when shortcut is null", () => {
    const result = validateShortcut(null);

    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("returns invalid when missing label", () => {
    const result = validateShortcut({ keys: "ctrl+l" });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("label")));
  });

  it("returns invalid when label is not a string", () => {
    const result = validateShortcut({ label: 123, keys: "ctrl+l" });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("label")));
  });

  it("returns invalid when missing keys", () => {
    const result = validateShortcut({ label: "Clear" });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("keys")));
  });

  it("returns invalid when keys is not a string", () => {
    const result = validateShortcut({ label: "Clear", keys: 123 });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("keys")));
  });

  it("returns invalid when label exceeds 50 characters", () => {
    const longLabel = "a".repeat(51);
    const result = validateShortcut({ label: longLabel, keys: "ctrl+t" });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("50 characters")));
  });

  it("collects multiple errors", () => {
    const result = validateShortcut({});

    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 2); // missing label and keys
  });

  it("allows label exactly 50 characters", () => {
    const label = "a".repeat(50);
    const result = validateShortcut({ label, keys: "ctrl+t" });

    assert.equal(result.valid, true);
  });
});

describe("ShortcutsSuccess", () => {
  it("creates success result with shortcuts", () => {
    const shortcuts = [{ label: "Test", keys: "ctrl+t" }];
    const result = new ShortcutsSuccess(shortcuts);

    assert.equal(result.success, true);
    assert.deepEqual(result.shortcuts, shortcuts);
  });
});

describe("ShortcutsFailure", () => {
  it("creates failure result with reason and message", () => {
    const result = new ShortcutsFailure("test-reason", "Test message");

    assert.equal(result.success, false);
    assert.equal(result.reason, "test-reason");
    assert.equal(result.message, "Test message");
  });
});
