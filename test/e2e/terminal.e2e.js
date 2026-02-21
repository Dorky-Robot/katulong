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
    // get swallowed or mangled, causing flaky failures.
    await page.waitForFunction(
      () => /[$➜%#>]/.test(document.querySelector('.xterm-rows')?.textContent || ''),
      { timeout: 10000 },
    );
    // Do NOT explicitly focus the xterm-helper-textarea here.
    // xterm auto-focuses it on page load; explicitly calling .focus() again
    // on mobile emulation activates IME autocorrect behaviors that inject
    // spurious characters ("clear"), and on desktop it switches the
    // accessibility layer to single-row mode, breaking .xterm-screen reads.
    // Keyboard events are routed to the auto-focused textarea automatically.
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

    // .xterm-rows only reflects the current prompt line on canvas renderers.
    // Use .xterm-screen which includes the full terminal viewport content.
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
    // waitForFunction itself is the assertion that marker1 appeared in output.
    // On narrow viewports marker1 may scroll off once marker2 is typed,
    // so we check each marker immediately after it appears rather than
    // asserting both at the same time at the end.
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
