import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectInstallMethod } from "../lib/cli/process-manager.js";
import { decideUpgradeAction } from "../lib/cli/commands/update.js";

// Helper: stub fsExists to return a fixed value
const gitExists = () => true;
const noGit = () => false;

describe("detectInstallMethod", () => {
  describe("homebrew detection", () => {
    it("detects /usr/local/opt/katulong as homebrew", () => {
      assert.equal(
        detectInstallMethod("/usr/local/opt/katulong/lib", noGit),
        "homebrew"
      );
    });

    it("detects /opt/homebrew/opt/katulong as homebrew", () => {
      assert.equal(
        detectInstallMethod("/opt/homebrew/opt/katulong", noGit),
        "homebrew"
      );
    });

    it("detects /usr/local/Cellar/katulong as homebrew", () => {
      assert.equal(
        detectInstallMethod("/usr/local/Cellar/katulong/0.5.0", noGit),
        "homebrew"
      );
    });

    it("detects /opt/homebrew/Cellar/katulong as homebrew", () => {
      assert.equal(
        detectInstallMethod("/opt/homebrew/Cellar/katulong/0.5.0", noGit),
        "homebrew"
      );
    });

    it("detects generic /usr/local path as homebrew fallback", () => {
      assert.equal(
        detectInstallMethod("/usr/local/share/katulong", noGit),
        "homebrew"
      );
    });

    it("detects generic /opt/homebrew path as homebrew fallback", () => {
      assert.equal(
        detectInstallMethod("/opt/homebrew/share/katulong", noGit),
        "homebrew"
      );
    });
  });

  describe("npm-global detection", () => {
    it("detects /usr/local/lib/node_modules/katulong as npm-global", () => {
      assert.equal(
        detectInstallMethod("/usr/local/lib/node_modules/katulong", noGit),
        "npm-global"
      );
    });

    it("detects ~/.nvm node_modules path as npm-global", () => {
      assert.equal(
        detectInstallMethod(
          "/home/user/.nvm/versions/node/v20.0.0/lib/node_modules/katulong",
          noGit
        ),
        "npm-global"
      );
    });
  });

  describe("git (manual install) detection", () => {
    it("detects ~/.katulong with .git as git", () => {
      assert.equal(
        detectInstallMethod("/home/user/.katulong", gitExists),
        "git"
      );
    });

    it("detects /root/.katulong with .git as git", () => {
      assert.equal(
        detectInstallMethod("/root/.katulong", gitExists),
        "git"
      );
    });
  });

  describe("dev detection", () => {
    it("detects project dir with .git as dev", () => {
      assert.equal(
        detectInstallMethod("/home/user/Projects/katulong", gitExists),
        "dev"
      );
    });

    it("detects any path with .git but not .katulong as dev", () => {
      assert.equal(
        detectInstallMethod("/tmp/katulong-checkout", gitExists),
        "dev"
      );
    });

    it("returns dev as ultimate fallback", () => {
      assert.equal(
        detectInstallMethod("/some/unknown/path", noGit),
        "dev"
      );
    });
  });

  describe("priority ordering", () => {
    it("homebrew opt takes priority over node_modules", () => {
      assert.equal(
        detectInstallMethod(
          "/usr/local/opt/katulong/node_modules/katulong",
          noGit
        ),
        "homebrew"
      );
    });

    it("node_modules takes priority over .git presence", () => {
      assert.equal(
        detectInstallMethod(
          "/usr/local/lib/node_modules/katulong",
          gitExists
        ),
        "npm-global"
      );
    });

    it("homebrew opt takes priority over .git presence", () => {
      assert.equal(
        detectInstallMethod("/opt/homebrew/opt/katulong", gitExists),
        "homebrew"
      );
    });
  });

  describe("edge cases", () => {
    it("does not match partial name /node_modules/katulong-extra", () => {
      // node_modules/katulong-extra contains /node_modules/katulong as substring
      // This is a known limitation: substring matching is imprecise
      // Documenting current behavior
      assert.equal(
        detectInstallMethod("/usr/lib/node_modules/katulong-extra", noGit),
        "npm-global"
      );
    });

    it("homebrew fallback matches /usr/local even without katulong in path", () => {
      assert.equal(
        detectInstallMethod("/usr/local/src/something-else", noGit),
        "homebrew"
      );
    });
  });
});

describe("decideUpgradeAction", () => {
  const base = {
    currentVersion: "1.0.0",
    newVersion: "1.0.0",
    runningVersion: "1.0.0",
    oldServerRunning: true,
    noRestart: false,
  };

  it("noop when on-disk and running both match latest", () => {
    assert.deepEqual(decideUpgradeAction(base), {
      action: "noop",
      reason: "already-up-to-date",
    });
  });

  it("runs finish-upgrade when on-disk binary was bumped", () => {
    assert.deepEqual(
      decideUpgradeAction({ ...base, currentVersion: "0.9.0" }),
      { action: "finish-upgrade", reason: "binary-upgraded" },
    );
  });

  it("runs finish-upgrade when running server is stale (binary already updated)", () => {
    // The bug we just fixed: on-disk == newVersion but the running PID
    // started from an earlier Cellar dir that has since been pruned.
    assert.deepEqual(
      decideUpgradeAction({ ...base, runningVersion: "0.9.0" }),
      { action: "finish-upgrade", reason: "running-server-stale" },
    );
  });

  it("noop with --no-restart even when an upgrade is needed", () => {
    assert.deepEqual(
      decideUpgradeAction({
        ...base,
        currentVersion: "0.9.0",
        noRestart: true,
      }),
      { action: "noop", reason: "no-restart" },
    );
  });

  it("noop with --no-restart even when running server is stale", () => {
    assert.deepEqual(
      decideUpgradeAction({
        ...base,
        runningVersion: "0.9.0",
        noRestart: true,
      }),
      { action: "noop", reason: "no-restart" },
    );
  });

  it("noop when no server is running, even on binary upgrade", () => {
    assert.deepEqual(
      decideUpgradeAction({
        ...base,
        currentVersion: "0.9.0",
        runningVersion: null,
        oldServerRunning: false,
      }),
      { action: "noop", reason: "no-running-server" },
    );
  });

  it("ignores unprobed runningVersion (null) when versions agree", () => {
    // /health probe failed (e.g., timeout). Don't fabricate staleness.
    assert.deepEqual(
      decideUpgradeAction({ ...base, runningVersion: null }),
      { action: "noop", reason: "already-up-to-date" },
    );
  });
});

describe("detectInstallMethod integration", () => {
  it("exports detectInstallMethod from process-manager", () => {
    assert.equal(typeof detectInstallMethod, "function");
  });

  it("returns a valid install method with no arguments (uses real ROOT)", () => {
    const method = detectInstallMethod();
    assert.ok(
      ["homebrew", "npm-global", "git", "dev"].includes(method),
      `Expected valid method, got: ${method}`
    );
  });

  it("returns dev for current project (has .git, not in .katulong)", () => {
    const method = detectInstallMethod();
    assert.equal(method, "dev");
  });
});
