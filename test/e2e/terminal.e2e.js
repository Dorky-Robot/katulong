import { test, expect } from "@playwright/test";
import { waitForAppReady } from './helpers.js';

test.describe("Terminal I/O", () => {
  // Each test uses its own session to avoid cross-test interference
  // when parallel workers type into the same default PTY session.
  let sessionName;

  test.beforeEach(async ({ page }, testInfo) => {
    sessionName = `term-io-${testInfo.testId}-${Date.now()}`;
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await waitForAppReady(page);
    await page.locator(".xterm-helper-textarea").focus();
    // Wait for shell prompt before typing — the shell runs init scripts
    // (e.g. .zshrc, clear) and keystrokes typed before the prompt appears
    // get swallowed, causing flaky failures.
    await page.waitForFunction(
      () => /[$➜❯%#>]/.test(document.querySelector('.xterm-rows')?.textContent || ''),
      { timeout: 10000 },
    );
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      sessionName,
    );
  });

  test("Shell prompt is visible after load", async ({ page }) => {
    const rows = page.locator(".xterm-rows");
    await expect(rows).not.toHaveText("");
  });

  test("Typed command produces visible output", async ({ page }) => {
    const marker = `marker_${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");

    const rows = page.locator(".xterm-rows");
    await expect(rows).toContainText(marker);
  });

  test("Multiple commands produce sequential output", async ({ page }) => {
    const marker1 = `first_${Date.now()}`;
    const marker2 = `second_${Date.now()}`;

    await page.keyboard.type(`echo ${marker1}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(marker1);

    await page.keyboard.type(`echo ${marker2}`);
    await page.keyboard.press("Enter");

    const rows = page.locator(".xterm-rows");
    await expect(rows).toContainText(marker1);
    await expect(rows).toContainText(marker2);
  });

  test("Terminal container background matches theme (no black gap)", async ({ page }) => {
    // The terminal container should use the theme background, not default black.
    // Without this, the area below the xterm canvas rows shows as a black strip.
    const containerBg = await page.evaluate(() => {
      const el = document.getElementById("terminal-container");
      return getComputedStyle(el).backgroundColor;
    });
    // Should NOT be pure black (rgb(0, 0, 0))
    expect(containerBg).not.toBe("rgb(0, 0, 0)");
    // Should match the page/body background
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(containerBg).toBe(bodyBg);
  });

  test("No console errors from vendor scripts (FitAddon compatibility)", async ({ page }) => {
    // Catch vendor version mismatch crashes like the scrollBarWidth error
    // that occurred when stale cached addon-fit.esm.js was loaded.
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // Navigate fresh to trigger all vendor script loads
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await waitForAppReady(page);

    const vendorErrors = errors.filter(e =>
      e.includes("vendor") || e.includes("FitAddon") || e.includes("scrollBarWidth")
    );
    expect(vendorErrors).toEqual([]);
  });

  test("Vendor files have content-hash cache busters", async ({ page }) => {
    const vendorUrls = [];
    page.on("request", (req) => {
      const url = req.url();
      // Only check .js and .css vendor files (not .map, .woff2, etc.)
      if (url.includes("/vendor/") && (url.includes(".js") || url.includes(".css"))) {
        vendorUrls.push(url);
      }
    });

    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await waitForAppReady(page);

    // At least xterm and addon-fit should be loaded
    expect(vendorUrls.length).toBeGreaterThan(0);
    for (const url of vendorUrls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.has("h")).toBe(true);
    }
  });

  test("Terminal fills available viewport height", async ({ page }) => {
    // The xterm canvas should fill most of the terminal container.
    // A gap > 20% means the terminal rows weren't fitted to the viewport
    // (e.g. stuck at default 24 rows when the viewport fits 48+).
    const ratio = await page.evaluate(() => {
      const container = document.getElementById("terminal-container");
      const screen = container.querySelector(".xterm-screen");
      if (!container || !screen) return 0;
      return screen.offsetHeight / container.offsetHeight;
    });
    // xterm rows are discrete so there's always a small gap at the bottom,
    // but the terminal should fill at least 80% of the container.
    expect(ratio).toBeGreaterThan(0.8);
  });

  test("No JS errors during terminal scale/resize", async ({ page }) => {
    // Regression: scaleToFit had a block-scoped `const fontSize` inside an
    // if-block but referenced it outside — ReferenceError on every call.
    // This test catches any uncaught JS error during load + viewport resize.
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await waitForAppReady(page);

    // Trigger a height-only resize (the exact path that hit the bug —
    // width unchanged means the if-block is skipped, fontSize undefined).
    const currentSize = page.viewportSize();
    await page.setViewportSize({ width: currentSize.width, height: currentSize.height - 50 });
    // Give ResizeObserver + rAF time to fire
    await page.waitForTimeout(500);
    await page.setViewportSize(currentSize);
    await page.waitForTimeout(500);

    expect(errors).toEqual([]);
  });

  test("Buffer replays on page reload", async ({ page }) => {
    const marker = `reload_${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(marker);

    await page.reload();
    await waitForAppReady(page);

    await expect(page.locator(".xterm-rows")).toContainText(marker);
  });
});
