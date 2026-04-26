import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildLaunchAgentPath, xmlEscape } from "../lib/cli/commands/service.js";

describe("xmlEscape", () => {
  it("escapes the five XML predefined entities", () => {
    assert.equal(
      xmlEscape(`<key>injected</key><string>&"'`),
      "&lt;key&gt;injected&lt;/key&gt;&lt;string&gt;&amp;&quot;&apos;",
    );
  });

  it("returns input unchanged when no metacharacters are present", () => {
    assert.equal(xmlEscape("/opt/homebrew/bin/katulong"), "/opt/homebrew/bin/katulong");
  });

  it("escapes & before other entities (no double-escape)", () => {
    // Naive ordering ("escape & last") would re-escape the & in &lt;
    // and produce &amp;lt;. Confirm that doesn't happen.
    assert.equal(xmlEscape("&<"), "&amp;&lt;");
  });

  it("coerces non-string input via String()", () => {
    assert.equal(xmlEscape(3001), "3001");
    assert.equal(xmlEscape(null), "null");
  });
});

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

  it("treats empty string the same as null", () => {
    assert.equal(buildLaunchAgentPath(""), buildLaunchAgentPath(null));
  });

  it("drops a binDir containing a colon (would split PATH)", () => {
    // dirname("/Users/a:b/katulong") === "/Users/a:b" — joining that with `:`
    // would silently insert an extra entry into PATH. Drop instead of corrupt.
    const result = buildLaunchAgentPath("/Users/a:b/katulong");
    const dirs = result.split(":");
    assert.ok(!dirs.includes("/Users/a"), `unexpected /Users/a entry: ${result}`);
    assert.ok(!dirs.includes("b"), `unexpected b entry: ${result}`);
    assert.equal(dirs[0], "/opt/homebrew/bin");
  });

  it("drops a binDir containing whitespace", () => {
    const result = buildLaunchAgentPath("/Users/foo bar/bin/katulong");
    const dirs = result.split(":");
    assert.ok(
      !dirs.some((d) => d.includes(" ")),
      `whitespace leaked into PATH: ${result}`,
    );
    assert.equal(dirs[0], "/opt/homebrew/bin");
  });
});
