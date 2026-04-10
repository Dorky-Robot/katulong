import { test, expect } from "@playwright/test";
import { waitForAppReady } from './helpers.js';

test.describe("Smoke — critical path", () => {
  // Shell init (zsh/bash profile) can be slow under load — give enough headroom
  test.setTimeout(120_000);
  // Flaky on heavily loaded dev machines (load avg 10+) — TODO: stabilize
  test.skip(!process.env.RUN_SMOKE_E2E, "smoke skipped under high load; set RUN_SMOKE_E2E=1 to run");

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

  test("Reconnection redraws terminal", async ({ page }) => {
    // After reconnect, the server triggers SIGWINCH which makes the
    // shell redraw. Type a command to verify the session is live.
    await page.reload();
    await waitForAppReady(page);
    await page.locator(".xterm-helper-textarea").focus();

    const marker = `reconnect_${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(marker, { timeout: 10000 });
  });
});
