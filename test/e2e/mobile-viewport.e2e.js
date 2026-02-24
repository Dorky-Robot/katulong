/**
 * Mobile Viewport Rendering Tests
 *
 * Regression tests for issue #259: mobile E2E shard failing because
 * window.visualViewport.height === 0 during initial JS module execution
 * in Chromium mobile emulation (isMobile: true). Without the fix in
 * public/lib/viewport-manager.js, #terminal-container gets height: -44px
 * (invalid CSS → 0), making .xterm { height: 100% } resolve to 0 and
 * Playwright's waitForSelector('.xterm') time out.
 *
 * These tests verify that the terminal is truly rendered with non-zero
 * dimensions after page load, catching any future regression regardless
 * of browser project (desktop or mobile).
 */

import { test, expect } from "@playwright/test";
import { waitForAppReady } from "./helpers.js";

test.describe("Viewport rendering", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
  });

  test("Terminal container has non-zero height after load", async ({ page }) => {
    // Regression: on mobile Chromium, visualViewport.height === 0 during init
    // caused termContainer.style.height to become '-44px' → browser clamps to 0.
    const height = await page.evaluate(
      () => document.getElementById("terminal-container")?.offsetHeight ?? 0,
    );
    expect(height).toBeGreaterThan(0);
  });

  test("--viewport-h CSS custom property is set to a positive value", async ({ page }) => {
    // resizeToViewport() sets --viewport-h to the resolved visual viewport height.
    // If it stays at 0 or unset, layout is broken and xterm renders invisibly.
    const vpH = await page.evaluate(() =>
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--viewport-h"),
      ),
    );
    expect(vpH).toBeGreaterThan(0);
  });

  test("xterm element has non-zero bounding box", async ({ page }) => {
    // This is the exact assertion that waitForAppReady relies on.
    // If the terminal container has height 0, .xterm inherits height 0
    // and Playwright's state:'visible' check fails — reproducing issue #259.
    const box = await page.locator(".xterm").boundingBox();
    expect(box).not.toBeNull();
    expect(box.height).toBeGreaterThan(0);
    expect(box.width).toBeGreaterThan(0);
  });
});
