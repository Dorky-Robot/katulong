/**
 * Tests for bridges/_lib/launchd-template.js — plist generation with a
 * deterministic PATH (lesson from katulong's own service install bug).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bridgeLabel,
  bridgePlistPath,
  buildBridgePlist,
} from "../bridges/_lib/launchd-template.js";

describe("bridge launchd template", () => {
  it("bridgeLabel uses the katulong-bridge namespace", () => {
    assert.equal(bridgeLabel("ollama"), "com.dorkyrobot.katulong-bridge.ollama");
  });

  it("bridgePlistPath is under ~/Library/LaunchAgents", () => {
    const path = bridgePlistPath("ollama");
    assert.match(path, /\/Library\/LaunchAgents\/com\.dorkyrobot\.katulong-bridge\.ollama\.plist$/);
  });

  it("buildBridgePlist invokes `katulong bridge <name> start` via the resolved bin", () => {
    const xml = buildBridgePlist({
      bridgeName: "ollama",
      bin: "/opt/homebrew/bin/katulong",
      dataDir: "/Users/felix/.katulong",
    });
    assert.ok(xml.includes("<string>/opt/homebrew/bin/katulong</string>"));
    assert.ok(xml.includes("<string>bridge</string>"));
    assert.ok(xml.includes("<string>ollama</string>"));
    assert.ok(xml.includes("<string>start</string>"));
  });

  it("plist PATH is deterministic and includes /opt/homebrew/bin", () => {
    // Set the calling shell's PATH to something stripped — the plist must
    // NOT inherit it. (Lesson from PR #662.)
    const original = process.env.PATH;
    process.env.PATH = "/some/random:/path";
    try {
      const xml = buildBridgePlist({
        bridgeName: "ollama",
        bin: "/opt/homebrew/bin/katulong",
        dataDir: "/Users/felix/.katulong",
      });
      assert.ok(xml.includes("/opt/homebrew/bin"), "missing /opt/homebrew/bin");
      assert.ok(xml.includes("/usr/bin"), "missing /usr/bin");
      assert.ok(!xml.includes("/some/random"), "leaked caller's PATH");
    } finally {
      process.env.PATH = original;
    }
  });

  it("plist sets log paths under <dataDir>/bridges/<name>/", () => {
    const xml = buildBridgePlist({
      bridgeName: "ollama",
      bin: "/opt/homebrew/bin/katulong",
      dataDir: "/Users/felix/.katulong",
    });
    assert.ok(xml.includes("/Users/felix/.katulong/bridges/ollama/stdout.log"));
    assert.ok(xml.includes("/Users/felix/.katulong/bridges/ollama/stderr.log"));
  });

  it("plist xml-escapes attacker-controlled bridge names", () => {
    // The bridge name is usually static, but xmlEscape protection should
    // hold defensively in case manifest data ever flows from untrusted input.
    const xml = buildBridgePlist({
      bridgeName: "evil</string><key>Foo</key><string>hi",
      bin: "/opt/homebrew/bin/katulong",
      dataDir: "/Users/felix/.katulong",
    });
    assert.ok(!xml.includes("<key>Foo</key>"), "XML injection succeeded");
    assert.ok(xml.includes("&lt;"), "no escaped angle brackets in output");
  });
});
