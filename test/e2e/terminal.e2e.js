import { test, expect } from "@playwright/test";
import { waitForAppReady } from './helpers.js';

test.describe("Terminal I/O", () => {
  // Run serially in one worker to avoid resource contention between PTY sessions.
  // Parallel workers competing for PTY I/O under CPU load causes timeout failures.
  test.describe.configure({ mode: 'serial' });

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
    // Focus the textarea AFTER the prompt appears so focus is held when
    // the test starts typing.
    await page.locator(".xterm-helper-textarea").focus();
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

    // .xterm-rows only reflects the current prompt line; use .xterm-screen
    // which contains the full terminal viewport including command output.
    await page.waitForFunction(
      (text) => document.querySelector('.xterm-screen')?.textContent?.includes(text),
      marker,
      { timeout: 5000 },
    );
    const termText = await page.locator('.xterm-screen').textContent();
    expect(termText).toContain(marker);
  });

  test("Multiple commands produce sequential output", async ({ page }) => {
    const marker1 = `first_${Date.now()}`;
    const marker2 = `second_${Date.now()}`;

    await page.keyboard.type(`echo ${marker1}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (text) => document.querySelector('.xterm-screen')?.textContent?.includes(text),
      marker1,
      { timeout: 5000 },
    );

    await page.keyboard.type(`echo ${marker2}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (text) => document.querySelector('.xterm-screen')?.textContent?.includes(text),
      marker2,
      { timeout: 5000 },
    );

    const termText = await page.locator('.xterm-screen').textContent();
    expect(termText).toContain(marker1);
    expect(termText).toContain(marker2);
  });

  test("Buffer replays on page reload", async ({ page }) => {
    const marker = `reload_${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (text) => document.querySelector('.xterm-screen')?.textContent?.includes(text),
      marker,
      { timeout: 5000 },
    );

    await page.reload();
    await waitForAppReady(page);

    await page.waitForFunction(
      (text) => document.querySelector('.xterm-screen')?.textContent?.includes(text),
      marker,
      { timeout: 5000 },
    );
    const termText = await page.locator('.xterm-screen').textContent();
    expect(termText).toContain(marker);
  });
});
