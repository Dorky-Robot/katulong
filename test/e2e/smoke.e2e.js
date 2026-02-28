import { test, expect } from "@playwright/test";
import { waitForAppReady } from './helpers.js';

test.describe("Smoke — critical path", () => {
  let sessionName;

  test.beforeEach(async ({ page }, testInfo) => {
    sessionName = `smoke-${testInfo.testId}-${Date.now()}`;
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await waitForAppReady(page);
    await page.locator(".xterm-helper-textarea").focus();
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      sessionName,
    );
  });

  test("App loads and terminal renders", async ({ page }) => {
    await expect(page.locator(".xterm-screen")).toBeVisible();
    const rows = page.locator(".xterm-rows");
    await expect(rows).not.toHaveText("");
  });

  test("Terminal I/O works (WebSocket + PTY)", async ({ page }) => {
    const marker = `smoke_${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(marker);
  });

  test("Reconnection replays buffer", async ({ page }) => {
    const marker = `reconnect_${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(marker);

    await page.reload();
    // After reconnect, wait for xterm to render the replayed buffer
    // (don't wait for a fresh shell prompt — buffer replay is sufficient)
    await page.waitForSelector(".xterm-screen", { timeout: 10000 });
    await expect(page.locator(".xterm-rows")).toContainText(marker, { timeout: 10000 });
  });
});
