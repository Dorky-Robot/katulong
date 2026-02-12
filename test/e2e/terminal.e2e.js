import { test, expect } from "@playwright/test";
import { waitForAppReady } from './helpers.js';

test.describe("Terminal I/O", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
    await page.locator(".xterm-helper-textarea").focus();
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
