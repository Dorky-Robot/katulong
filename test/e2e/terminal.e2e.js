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
    // Wait for shell prompt before typing — the shell runs init scripts
    // (e.g. .zshrc, clear) and keystrokes typed before the prompt appears
    // get swallowed, causing flaky failures.
    await page.waitForFunction(
      () => /[$➜%#>]/.test(document.querySelector('.xterm-rows')?.textContent || ''),
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

  test("Typed command produces visible output", async ({ page, isMobile }) => {
    // Mobile browser emulation does not support terminal keyboard input
    // (touch keyboards / mobile input model differs from desktop PTY interaction)
    test.skip(isMobile, "Terminal keyboard input not testable in mobile emulation");

    const marker = `marker_${Date.now()}`;
    await page.locator(".xterm-helper-textarea").pressSequentially(`echo ${marker}`);
    await page.locator(".xterm-helper-textarea").press("Enter");

    const rows = page.locator(".xterm-rows");
    await expect(rows).toContainText(marker);
  });

  test("Multiple commands produce sequential output", async ({ page, isMobile }) => {
    test.skip(isMobile, "Terminal keyboard input not testable in mobile emulation");

    const marker1 = `first_${Date.now()}`;
    const marker2 = `second_${Date.now()}`;
    const textarea = page.locator(".xterm-helper-textarea");

    await textarea.pressSequentially(`echo ${marker1}`);
    await textarea.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(marker1);

    await textarea.pressSequentially(`echo ${marker2}`);
    await textarea.press("Enter");

    const rows = page.locator(".xterm-rows");
    await expect(rows).toContainText(marker1);
    await expect(rows).toContainText(marker2);
  });

  test("Buffer replays on page reload", async ({ page, isMobile }) => {
    test.skip(isMobile, "Terminal keyboard input not testable in mobile emulation");

    const marker = `reload_${Date.now()}`;
    const textarea = page.locator(".xterm-helper-textarea");
    await textarea.pressSequentially(`echo ${marker}`);
    await textarea.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(marker);

    await page.reload();
    await waitForAppReady(page);

    await expect(page.locator(".xterm-rows")).toContainText(marker);
  });
});
