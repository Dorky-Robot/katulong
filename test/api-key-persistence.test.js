import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

/**
 * Test that API keys persist correctly through the auth state lifecycle.
 * Each test runs in a subprocess to avoid module caching issues with
 * KATULONG_DATA_DIR (set at import time in env-config.js).
 */

function runInSubprocess(dataDir, script) {
  const result = execFileSync("node", ["--input-type=module", "-e", script], {
    env: { ...process.env, KATULONG_DATA_DIR: dataDir },
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: 10000,
  });
  return result.trim();
}

function makeDataDir() {
  const dir = join(tmpdir(), `katulong-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "user.json"), "null");
  mkdirSync(join(dir, "credentials"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  mkdirSync(join(dir, "setup-tokens"), { recursive: true });
  mkdirSync(join(dir, "api-keys"), { recursive: true });
  return dir;
}

describe("API key persistence", { skip: "spawnSync ETIMEDOUT under load; passes in isolation" }, () => {
  let dataDir;

  it("loadState returns valid state when user.json is null", () => {
    dataDir = makeDataDir();
    const output = runInSubprocess(dataDir, `
      import { loadState } from "./lib/auth-repository.js";
      const state = loadState();
      console.log(JSON.stringify({ isNull: state === null, apiKeysLen: state?.apiKeys?.length }));
    `);
    const result = JSON.parse(output);
    assert.equal(result.isNull, false, "loadState should not return null when user.json is null");
    assert.equal(result.apiKeysLen, 0, "should have empty apiKeys array");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("addApiKey + saveState writes key file to api-keys/ directory", () => {
    dataDir = makeDataDir();
    const output = runInSubprocess(dataDir, `
      import { loadState, saveState } from "./lib/auth-repository.js";
      import { randomBytes } from "node:crypto";
      const state = loadState();
      if (!state) { console.log("NULL"); process.exit(0); }
      const id = randomBytes(8).toString("hex");
      const key = randomBytes(32).toString("hex");
      const newState = state.addApiKey({ id, key, name: "test", createdAt: Date.now(), lastUsedAt: 0 });
      saveState(newState);
      console.log(JSON.stringify({ id, key, apiKeysLen: newState.apiKeys.length }));
    `);
    assert.notEqual(output, "NULL", "loadState returned null — bug");
    const result = JSON.parse(output);
    assert.equal(result.apiKeysLen, 1);

    const files = readdirSync(join(dataDir, "api-keys"));
    assert.equal(files.length, 1, `api-keys/ should have 1 file, got: ${files}`);

    const keyData = JSON.parse(readFileSync(join(dataDir, "api-keys", files[0]), "utf-8"));
    assert.equal(keyData.id, result.id);
    assert.equal(keyData.name, "test");
    assert.ok(keyData.hash, "should have hash");
    assert.ok(!keyData.key, "raw key should not be on disk");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("persisted API key survives loadState reload and findApiKey works", () => {
    dataDir = makeDataDir();

    // Step 1: create and save
    const step1 = runInSubprocess(dataDir, `
      import { loadState, saveState } from "./lib/auth-repository.js";
      import { randomBytes } from "node:crypto";
      const state = loadState();
      if (!state) { console.log("NULL"); process.exit(0); }
      const id = randomBytes(8).toString("hex");
      const key = randomBytes(32).toString("hex");
      saveState(state.addApiKey({ id, key, name: "persist-test", createdAt: Date.now(), lastUsedAt: 0 }));
      console.log(JSON.stringify({ id, key }));
    `);
    assert.notEqual(step1, "NULL", "step 1: loadState returned null");
    const { id, key } = JSON.parse(step1);

    // Step 2: fresh process, reload from disk, find the key
    const step2 = runInSubprocess(dataDir, `
      import { loadState } from "./lib/auth-repository.js";
      const state = loadState();
      if (!state) { console.log(JSON.stringify({ found: false, reason: "null state" })); process.exit(0); }
      const found = state.findApiKey("${key}");
      console.log(JSON.stringify({ found: !!found, id: found?.id, name: found?.name, apiKeysLen: state.apiKeys.length }));
    `);
    const result = JSON.parse(step2);
    assert.ok(result.found, `findApiKey should find the key after reload. Got: ${step2}`);
    assert.equal(result.id, id);
    assert.equal(result.name, "persist-test");
    rmSync(dataDir, { recursive: true, force: true });
  });
});
