/**
 * Peers config — `parseSipagHostsToml` + ConfigManager.getPeers /
 * setPeers / getPeerById.
 *
 * Why these tests
 *   The cross-instance-tile spike auto-imports peer credentials from
 *   `~/.sipag/hosts.toml` until an explicit setPeers happens. That
 *   bootstrap is convenient but creates several invisible failure modes
 *   (duplicate ids, malformed entries, key fields silently missing) that
 *   would only surface when a remote-tile fails to attach for unclear
 *   reasons. These tests pin the validation surface so the bootstrap
 *   path stays trustworthy.
 *
 *   The redaction tests pin the contract that getConfig() — which IS
 *   reflected over /api/config to any authed client — never leaks an
 *   apiKey, because the cost of a regression there is leaking peer keys
 *   to anyone who can read katulong's config dump.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ConfigManager, parseSipagHostsToml } from "../lib/config.js";

// ── parseSipagHostsToml ────────────────────────────────────────────
describe("parseSipagHostsToml — happy path", () => {
  it("parses the canonical [[host]] array-of-tables shape", () => {
    const peers = parseSipagHostsToml(`
[[host]]
id     = "mini"
url    = "https://katulong-mini.example"
apiKey = "0123456789abcdef0123456789abcdef"

[[host]]
id     = "prime"
url    = "https://katulong-prime.example"
apiKey = "fedcba9876543210fedcba9876543210"
label  = "Prime · home"
`);
    assert.equal(peers.length, 2);
    assert.equal(peers[0].id, "mini");
    assert.equal(peers[0].url, "https://katulong-mini.example");
    assert.equal(peers[0].apiKey, "0123456789abcdef0123456789abcdef");
    assert.equal(peers[1].label, "Prime · home");
  });

  it("ignores comments and blank lines", () => {
    const peers = parseSipagHostsToml(`
# top of file
[[host]]
# this peer is the home box
id     = "mini"  # the small one
url    = "https://x.example"
apiKey = "k1k1k1k1k1k1k1k1"

`);
    assert.equal(peers.length, 1);
    assert.equal(peers[0].id, "mini");
  });

  it("ignores top-level scalars before the first [[host]]", () => {
    // Future-proofs the bootstrap against a hosts.toml that grows other
    // sections (e.g., a `default` field). Don't choke on it.
    const peers = parseSipagHostsToml(`
default = "mini"

[[host]]
id     = "mini"
url    = "https://x.example"
apiKey = "k1k1k1k1k1k1k1k1"
`);
    assert.equal(peers.length, 1);
  });
});

describe("parseSipagHostsToml — bad input", () => {
  it("returns [] for non-string input", () => {
    assert.deepEqual(parseSipagHostsToml(null), []);
    assert.deepEqual(parseSipagHostsToml(undefined), []);
    assert.deepEqual(parseSipagHostsToml(42), []);
  });

  it("drops host entries missing id, url, or apiKey", () => {
    // A half-written entry should not silently appear as a peer the
    // user can pick — that would produce confusing 'Peer unreachable'
    // errors at tile-spawn time.
    const peers = parseSipagHostsToml(`
[[host]]
id     = "incomplete"
url    = "https://x.example"
# no apiKey

[[host]]
id     = "good"
url    = "https://y.example"
apiKey = "1234567890abcdef"
`);
    assert.equal(peers.length, 1);
    assert.equal(peers[0].id, "good");
  });

  it("returns [] when the file has no [[host]] tables", () => {
    assert.deepEqual(parseSipagHostsToml(`# nothing here\n`), []);
  });
});

// ── ConfigManager.getPeers / setPeers / getPeerById ────────────────
describe("ConfigManager.peers — explicit set + read", () => {
  let testDir;
  let cm;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-peers-test-"));
    cm = new ConfigManager(testDir);
    cm.initialize();
  });

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("setPeers persists and getPeerById returns the full record", async () => {
    await cm.setPeers([
      { id: "mini", url: "https://katulong-mini.example", apiKey: "key-1234567890abcdef" },
    ]);
    const found = cm.getPeerById("mini");
    assert.equal(found.id, "mini");
    assert.equal(found.url, "https://katulong-mini.example");
    assert.equal(found.apiKey, "key-1234567890abcdef");
  });

  it("getPeers omits apiKey from every entry", () => {
    // Load-bearing: this is what the picker UI receives. If apiKey
    // ever leaks into this path, every authenticated client of this
    // katulong instance gets every peer's key for free.
    cm._set("peers", [
      { id: "p1", url: "https://x.example", apiKey: "secret-1234567890abcd" },
    ]);
    const list = cm.getPeers();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "p1");
    assert.equal(list[0].apiKey, undefined, "apiKey must NOT appear on /api/peers entries");
  });

  it("getConfig redacts apiKey from peers", () => {
    cm._set("peers", [
      { id: "p1", url: "https://x.example", apiKey: "secret-1234567890abcd" },
    ]);
    const dumped = cm.getConfig();
    assert.equal(dumped.peers.length, 1);
    assert.equal(dumped.peers[0].apiKey, undefined);
  });

  it("setPeers rejects an entry with an invalid id", async () => {
    await assert.rejects(
      cm.setPeers([{ id: "bad/id", url: "https://x.example", apiKey: "k".repeat(32) }]),
      /peer id must match/,
    );
  });

  it("setPeers rejects duplicate ids", async () => {
    await assert.rejects(
      cm.setPeers([
        { id: "p", url: "https://x.example", apiKey: "k".repeat(32) },
        { id: "p", url: "https://y.example", apiKey: "k".repeat(32) },
      ]),
      /duplicate peer id/,
    );
  });

  it("setPeers rejects non-http(s) urls", async () => {
    await assert.rejects(
      cm.setPeers([{ id: "p", url: "ftp://x.example", apiKey: "k".repeat(32) }]),
      /url must use http or https/,
    );
  });

  it("setPeers rejects urls with embedded credentials", async () => {
    await assert.rejects(
      cm.setPeers([{ id: "p", url: "https://user:pass@x.example", apiKey: "k".repeat(32) }]),
      /must not contain credentials/,
    );
  });

  it("setPeers rejects too-short api keys", async () => {
    await assert.rejects(
      cm.setPeers([{ id: "p", url: "https://x.example", apiKey: "short" }]),
      /apiKey must be 16-512/,
    );
  });

  it("setPeers strips trailing slashes from url", async () => {
    await cm.setPeers([{ id: "p", url: "https://x.example/", apiKey: "k".repeat(32) }]);
    assert.equal(cm.getPeerById("p").url, "https://x.example");
  });

  it("setPeers(null) clears peers", async () => {
    await cm.setPeers([{ id: "p", url: "https://x.example", apiKey: "k".repeat(32) }]);
    await cm.setPeers(null);
    assert.deepEqual(cm.getPeers(), []);
  });
});

describe("ConfigManager.peers — sipag hosts.toml fallback", () => {
  // Each test sets up its own isolated HOME via `withFakeHome`.
  // beforeEach/afterEach state-juggling raced with node:test's hook
  // ordering on this file (the empty-fallback case picked up the real
  // peers from the developer's actual ~/.sipag/hosts.toml when it ran
  // after other tests in the same file). Per-test scoping is cheap
  // and removes the cross-test coupling entirely.
  function withFakeHome(fn) {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-peers-fallback-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "fakehome-"));
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const cm = new ConfigManager(testDir);
      cm.initialize();
      return fn({ cm, fakeHome });
    } finally {
      process.env.HOME = savedHome;
      rmSync(testDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }

  it("auto-imports peers from ~/.sipag/hosts.toml when peers config is empty", () => {
    withFakeHome(({ cm, fakeHome }) => {
      mkdirSync(join(fakeHome, ".sipag"), { recursive: true });
      writeFileSync(
        join(fakeHome, ".sipag", "hosts.toml"),
        `
[[host]]
id     = "mini"
url    = "https://katulong-mini.example"
apiKey = "0123456789abcdef0123456789abcdef"
`,
        "utf-8",
      );
      const list = cm.getPeers();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, "mini");
      assert.equal(list[0].apiKey, undefined, "fallback path also omits apiKey from getPeers");
      assert.equal(cm.getPeerById("mini").apiKey, "0123456789abcdef0123456789abcdef");
    });
  });

  it("explicit setPeers wins over hosts.toml fallback", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-peers-fallback-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "fakehome-"));
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      mkdirSync(join(fakeHome, ".sipag"), { recursive: true });
      writeFileSync(
        join(fakeHome, ".sipag", "hosts.toml"),
        `
[[host]]
id     = "mini"
url    = "https://from-sipag.example"
apiKey = "${"x".repeat(32)}"
`,
        "utf-8",
      );
      const cm = new ConfigManager(testDir);
      cm.initialize();
      await cm.setPeers([{ id: "mini", url: "https://from-katulong.example", apiKey: "k".repeat(32) }]);
      assert.equal(cm.getPeerById("mini").url, "https://from-katulong.example");
    } finally {
      process.env.HOME = savedHome;
      rmSync(testDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns [] when neither stored peers nor hosts.toml exist", () => {
    withFakeHome(({ cm }) => {
      // Sanity: confirm HOME is the override at the moment getPeers runs.
      assert.match(process.env.HOME || "", /fakehome-/, "HOME override must be active inside the test");
      assert.deepEqual(cm.getPeers(), []);
      assert.equal(cm.getPeerById("anything"), null);
    });
  });
});
