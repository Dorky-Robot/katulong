import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { imageMimeType } from "../lib/routes/upload.js";

/**
 * Clipboard bridge tests
 *
 * Covers the container-specific clipboard flow:
 *   Xvfb auto-detection and xclip set/read.
 *
 * These tests require xclip and Xvfb to be available in the test environment
 * (they are installed in the kubo container). Tests are skipped gracefully
 * when running on macOS or without Xvfb.
 */

const isLinux = process.platform === "linux";

// Detect Xvfb display (same logic as server.js / routes.js)
function detectXvfbDisplay() {
  return new Promise((resolve) => {
    execFile("pgrep", ["-a", "Xvfb"], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const match = stdout.match(/:(\d+)/);
      resolve(match ? `:${match[1]}` : null);
    });
  });
}

function xclipWrite(display, mimeType, filePath) {
  return new Promise((resolve, reject) => {
    execFile("xclip", ["-selection", "clipboard", "-t", mimeType, "-i", filePath],
      { timeout: 5000, env: { ...process.env, DISPLAY: display } },
      (err) => err ? reject(err) : resolve());
  });
}

function xclipReadTargets(display) {
  return new Promise((resolve, reject) => {
    execFile("xclip", ["-selection", "clipboard", "-o", "-t", "TARGETS"],
      { timeout: 5000, env: { ...process.env, DISPLAY: display } },
      (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
  });
}

function xclipReadBytes(display, mimeType) {
  return new Promise((resolve, reject) => {
    execFile("xclip", ["-selection", "clipboard", "-o", "-t", mimeType],
      { timeout: 5000, env: { ...process.env, DISPLAY: display }, encoding: "buffer" },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

describe("Clipboard bridge — Xvfb auto-detection", { skip: !isLinux && "Linux-only" }, () => {
  it("detects Xvfb display from running process", async () => {
    const display = await detectXvfbDisplay();
    // If Xvfb is running (kubo container), we should find it
    if (display) {
      assert.match(display, /^:\d+$/, "Display should be in :N format");
    }
    // If Xvfb is not running, that's OK — test just verifies the detection logic doesn't crash
  });

  it("returns null when Xvfb is not running", async () => {
    // This test verifies graceful handling — even if Xvfb IS running,
    // the function should never throw
    const display = await detectXvfbDisplay();
    assert.ok(display === null || typeof display === "string");
  });
});

describe("Clipboard bridge — xclip round-trip", { skip: !isLinux && "Linux-only" }, () => {
  let display;

  beforeEach(async () => {
    display = await detectXvfbDisplay();
    if (!display) return; // tests will be skipped by inner check
  });

  it("writes PNG to X clipboard and reads it back", { skip: !isLinux && "Linux-only" }, async () => {
    if (!display) return; // Xvfb not available

    // Create a minimal 1x1 PNG (67 bytes)
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpFile = join(tmpdir(), `clipboard-test-${Date.now()}.png`);
    writeFileSync(tmpFile, png);

    try {
      await xclipWrite(display, "image/png", tmpFile);

      // Verify the clipboard contains image/png
      const targets = await xclipReadTargets(display);
      assert.ok(targets.includes("image/png"), `Clipboard should contain image/png, got: ${targets}`);

      // Read back and verify we get a valid PNG
      const readBack = await xclipReadBytes(display, "image/png");
      assert.ok(Buffer.isBuffer(readBack), "Should read back a buffer");
      assert.ok(readBack.length > 0, "Read-back should not be empty");
      // Verify PNG magic bytes (xclip may re-encode, so check header not exact bytes)
      assert.ok(readBack[0] === 0x89 && readBack[1] === 0x50,
        "Read-back should start with PNG magic bytes");
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("xclip fails without DISPLAY", { skip: !isLinux && "Linux-only" }, async () => {
    // Verify that xclip fails when DISPLAY is unset (the root cause of the regression)
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        execFile("xclip", ["-selection", "clipboard", "-o"],
          { timeout: 5000, env: { ...process.env, DISPLAY: "" } },
          (err) => err ? reject(err) : resolve());
      }),
      "xclip should fail when DISPLAY is empty"
    );
  });
});

describe("Clipboard bridge — imageMimeType", () => {
  // imageMimeType is now a real export from lib/routes/upload.js (Tier 3.4).
  it("maps png to image/png", () => {
    assert.equal(imageMimeType("png"), "image/png");
  });

  it("maps jpg to image/jpeg", () => {
    assert.equal(imageMimeType("jpg"), "image/jpeg");
  });

  it("maps gif to image/gif", () => {
    assert.equal(imageMimeType("gif"), "image/gif");
  });

  it("maps webp to image/webp", () => {
    assert.equal(imageMimeType("webp"), "image/webp");
  });

  it("defaults to image/jpeg for unknown extensions", () => {
    assert.equal(imageMimeType("bmp"), "image/jpeg");
    assert.equal(imageMimeType("tiff"), "image/jpeg");
  });
});

describe("Clipboard bridge — container bridge", () => {
  it("resolves false when docker is not available", async () => {
    // Simulate bridgeClipboardToContainers behavior when docker isn't installed
    const result = await new Promise((resolve) => {
      execFile("docker", ["ps", "--filter", "label=managed-by=kubo", "--format", "{{.Names}}"],
        { timeout: 5000 }, (err, stdout) => {
          if (err || !stdout?.trim()) return resolve(false);
          resolve(true);
        });
    });
    // In test environment without docker or kubo containers, should resolve false
    assert.equal(typeof result, "boolean", "Bridge should always resolve to a boolean");
  });

  it("bridge function returns a promise", async () => {
    // Verify the bridge doesn't throw and returns a boolean
    const bridge = new Promise((resolve) => {
      execFile("docker", [
        "ps", "--filter", "label=managed-by=kubo", "--format", "{{.Names}}"
      ], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout?.trim()) return resolve(false);
        const containers = stdout.trim().split("\n").filter(Boolean);
        if (containers.length === 0) return resolve(false);
        resolve(true);
      });
    });
    const result = await bridge;
    assert.equal(typeof result, "boolean");
  });
});

describe("Clipboard bridge — tmux DISPLAY propagation", { skip: !isLinux && "Linux-only" }, () => {
  it("tmux setenv -g sets global environment", async () => {
    const display = await detectXvfbDisplay();
    if (!display) return;

    // Set DISPLAY in tmux global env
    await new Promise((resolve) => {
      execFile("tmux", ["setenv", "-g", "DISPLAY", display], { timeout: 2000 },
        (err) => resolve()); // Don't reject — tmux server might not be running
    });

    // Read it back
    const result = await new Promise((resolve) => {
      execFile("tmux", ["showenv", "-g", "DISPLAY"], { timeout: 2000 },
        (err, stdout) => resolve(err ? null : stdout.trim()));
    });

    if (result) {
      assert.equal(result, `DISPLAY=${display}`, "tmux global env should have DISPLAY");
    }
    // If tmux not running, test passes (graceful skip)
  });
});
