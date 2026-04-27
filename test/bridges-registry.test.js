/**
 * Tests for bridges/_lib/registry.js — auto-discovery of bridges from
 * `bridges/<name>/manifest.js` files.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listBridges, getBridge, isValidBridgeName } from "../bridges/_lib/registry.js";

describe("isValidBridgeName", () => {
  it("accepts simple lowercase names", () => {
    assert.equal(isValidBridgeName("ollama"), true);
    assert.equal(isValidBridgeName("redis"), true);
    assert.equal(isValidBridgeName("postgres"), true);
  });

  it("accepts hyphenated names", () => {
    assert.equal(isValidBridgeName("vector-db"), true);
    assert.equal(isValidBridgeName("ollama-cloud"), true);
  });

  it("rejects names starting with hyphen", () => {
    assert.equal(isValidBridgeName("-foo"), false);
  });

  it("rejects names with shell metacharacters", () => {
    // The cases that motivated adding the allowlist — these would
    // otherwise reach execFileSync via plistPath / launchctl args.
    assert.equal(isValidBridgeName('foo"$(touch /tmp/pwn)"'), false);
    assert.equal(isValidBridgeName("foo; rm -rf /"), false);
    assert.equal(isValidBridgeName("foo`id`"), false);
    assert.equal(isValidBridgeName("foo|bar"), false);
  });

  it("rejects path-traversal attempts", () => {
    assert.equal(isValidBridgeName(".."), false);
    assert.equal(isValidBridgeName("../etc"), false);
    assert.equal(isValidBridgeName("foo/bar"), false);
    assert.equal(isValidBridgeName("foo\\bar"), false);
  });

  it("rejects uppercase or unicode", () => {
    assert.equal(isValidBridgeName("Ollama"), false);
    assert.equal(isValidBridgeName("ollamä"), false);
  });

  it("rejects names over 64 chars", () => {
    assert.equal(isValidBridgeName("a".repeat(64)), true);
    assert.equal(isValidBridgeName("a".repeat(65)), false);
  });

  it("rejects reserved names that collide with top-level CLI commands", () => {
    assert.equal(isValidBridgeName("list"), false);
  });

  it("rejects non-strings", () => {
    assert.equal(isValidBridgeName(null), false);
    assert.equal(isValidBridgeName(undefined), false);
    assert.equal(isValidBridgeName(123), false);
  });
});

describe("bridge registry", () => {
  it("discovers the ollama bridge from its manifest", async () => {
    const bridges = await listBridges();
    const names = bridges.map((b) => b.name);
    assert.ok(names.includes("ollama"), `expected "ollama" in [${names.join(", ")}]`);
  });

  it("getBridge returns the manifest", async () => {
    const ollama = await getBridge("ollama");
    assert.equal(ollama.name, "ollama");
    assert.equal(typeof ollama.port, "number");
    assert.match(ollama.target, /^https?:\/\//);
  });

  it("getBridge throws a helpful error for unknown bridges", async () => {
    await assert.rejects(
      () => getBridge("does-not-exist"),
      /unknown bridge "does-not-exist"/,
    );
  });

  it("getBridge rejects invalid names BEFORE looking them up", async () => {
    // Important: the rejection must happen via the allowlist regex, not
    // via "unknown bridge" — otherwise an attacker could probe for the
    // existence of arbitrary directories.
    await assert.rejects(
      () => getBridge('foo"$(id)"'),
      /invalid bridge name/,
    );
    await assert.rejects(
      () => getBridge("../etc"),
      /invalid bridge name/,
    );
  });

  it("manifests are returned in alphabetical order", async () => {
    const bridges = await listBridges();
    const names = bridges.map((b) => b.name);
    const sorted = [...names].sort();
    assert.deepEqual(names, sorted);
  });
});
