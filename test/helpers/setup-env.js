/**
 * Test environment setup — loaded via --import before any test modules.
 *
 * Sets KATULONG_DATA_DIR to a temporary directory so auth tests don't
 * write to the real ~/.katulong/ (which may be owned by root in CI/containers).
 * The directory is cleaned up on process exit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (!process.env.KATULONG_DATA_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "katulong-test-"));
  process.env.KATULONG_DATA_DIR = dir;

  process.on("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}
