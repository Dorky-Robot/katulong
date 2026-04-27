/**
 * Tests for bridges/_lib/registry.js — auto-discovery of bridges from
 * `bridges/<name>/manifest.js` files.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listBridges, getBridge } from "../bridges/_lib/registry.js";

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

  it("manifests are returned in alphabetical order", async () => {
    const bridges = await listBridges();
    const names = bridges.map((b) => b.name);
    const sorted = [...names].sort();
    assert.deepEqual(names, sorted);
  });
});
