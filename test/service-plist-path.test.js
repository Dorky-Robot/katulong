import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildLaunchAgentPath } from "../lib/cli/commands/service.js";

describe("buildLaunchAgentPath", () => {
  it("includes Homebrew, system, and bin-dir entries even when invoked from a stripped shell", () => {
    // Regression for the bug fixed in this PR: the plist used to inherit
    // process.env.PATH, so a non-interactive ssh's stripped PATH would
    // bake into the LaunchAgent and break tmux/node lookup on respawn.
    const result = buildLaunchAgentPath("/opt/homebrew/bin/katulong");
    const dirs = result.split(":");
    assert.ok(dirs.includes("/opt/homebrew/bin"), "missing /opt/homebrew/bin");
    assert.ok(dirs.includes("/opt/homebrew/sbin"), "missing /opt/homebrew/sbin");
    assert.ok(dirs.includes("/usr/local/bin"), "missing /usr/local/bin");
    assert.ok(dirs.includes("/usr/bin"), "missing /usr/bin");
    assert.ok(dirs.includes("/bin"), "missing /bin");
    assert.ok(dirs.includes("/usr/sbin"), "missing /usr/sbin");
    assert.ok(dirs.includes("/sbin"), "missing /sbin");
  });

  it("does NOT include the calling shell's PATH entries", () => {
    const sentinel = "/some/random/user/path";
    const originalPath = process.env.PATH;
    process.env.PATH = `${sentinel}:/usr/bin`;
    try {
      const result = buildLaunchAgentPath("/opt/homebrew/bin/katulong");
      assert.ok(
        !result.split(":").includes(sentinel),
        `unexpected entry from process.env.PATH: ${result}`,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("prepends the bin's parent dir when it isn't in the standard set", () => {
    // npm-global / nvm / manual installs live outside the Homebrew dirs.
    const result = buildLaunchAgentPath(
      "/Users/foo/.nvm/versions/node/v20.0.0/bin/katulong",
    );
    const dirs = result.split(":");
    assert.equal(dirs[0], "/Users/foo/.nvm/versions/node/v20.0.0/bin");
    assert.ok(dirs.includes("/opt/homebrew/bin"));
  });

  it("does NOT duplicate the bin's parent dir when it's already standard", () => {
    const result = buildLaunchAgentPath("/opt/homebrew/bin/katulong");
    const dirs = result.split(":");
    const homebrewBinCount = dirs.filter((d) => d === "/opt/homebrew/bin").length;
    assert.equal(homebrewBinCount, 1, "expected /opt/homebrew/bin exactly once");
  });

  it("handles a missing bin path by returning just the standard set", () => {
    const result = buildLaunchAgentPath(null);
    const dirs = result.split(":");
    assert.equal(dirs[0], "/opt/homebrew/bin");
    assert.ok(dirs.includes("/sbin"));
  });
});
