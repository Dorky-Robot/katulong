import { describe, it } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";

describe("CA Commands (deprecated)", () => {
  it("should print deprecation message and exit with code 1", () => {
    try {
      execSync(`node bin/katulong ca`, {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.fail("Should have exited with non-zero code");
    } catch (error) {
      // execSync throws on non-zero exit
      assert.ok(error.stderr.includes("deprecated"), "Should print deprecation message");
      assert.strictEqual(error.status, 1, "Should exit with code 1");
    }
  });

  it("should print deprecation message for ca info subcommand", () => {
    try {
      execSync(`node bin/katulong ca info`, {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.fail("Should have exited with non-zero code");
    } catch (error) {
      assert.ok(error.stderr.includes("deprecated"), "Should print deprecation message");
      assert.strictEqual(error.status, 1, "Should exit with code 1");
    }
  });
});
