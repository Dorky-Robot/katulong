/**
 * Verify that artificial delay constants have been reduced
 * to improve terminal responsiveness.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relPath) {
  return readFileSync(join(root, relPath), "utf8");
}

describe("reduced timeout constants", () => {
  it("pull-manager: PULL_TIMEOUT_MS = 1000", () => {
    const src = readSource("public/lib/pull-manager.js");
    assert.match(src, /const PULL_TIMEOUT_MS = 1000;/);
  });

  it("pull-manager: WRITE_TIMEOUT_MS = 2000", () => {
    const src = readSource("public/lib/pull-manager.js");
    assert.match(src, /const WRITE_TIMEOUT_MS = 2000;/);
  });

  it("pull-manager: write-rejection retry delay = 100ms", () => {
    const src = readSource("public/lib/pull-manager.js");
    // The retry setTimeout after write rejection should use 100ms
    assert.match(src, /if \(ps\.pending\) \{ ps\.pending = false; pull\(name\); \}\n\s*\}, 100\)/);
  });

  it("routes: PASTE_DELAY_MS = 50", () => {
    const src = readSource("lib/routes/app-routes.js");
    assert.match(src, /const PASTE_DELAY_MS = 50;/);
  });

  it("key-mapping: inter-key delay = 50ms", () => {
    const src = readSource("public/lib/key-mapping.js");
    assert.match(src, /i \* 50/);
  });
});
