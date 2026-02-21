import { test, expect } from "@playwright/test";
import { waitForAppReady, waitForTerminalOutput } from './helpers.js';

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
    // On desktop: explicitly focus the xterm textarea so Playwright's keyboard
    // routing correctly targets it. In serial mode, after multiple page.goto()
    // navigations the auto-focus from term.focus() (app.js) may not be
    // registered with Playwright's input system, causing keyboard.type() to
    // silently discard keystrokes.
    //
    // On mobile: do NOT focus — explicitly calling .focus() on mobile emulation
    // activates IME autocorrect that injects spurious characters ("clear").
    // xterm auto-focuses on page load and that is sufficient for mobile.
    if (testInfo.project.name !== 'mobile') {
      await page.locator('.xterm-helper-textarea').focus();
    }
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

    // Use xterm's internal buffer (window.__xterm.buffer.active) rather than
    // .xterm-screen.textContent. The canvas renderer's accessibility layer only
    // exposes the current cursor row; the output row disappears once the shell
    // returns to the prompt. The buffer retains all lines permanently.
    await waitForTerminalOutput(page, marker);
  });

  test("Multiple commands produce sequential output", async ({ page }) => {
    const marker1 = `first_${Date.now()}`;
    const marker2 = `second_${Date.now()}`;

    await page.keyboard.type(`echo ${marker1}`);
    await page.keyboard.press("Enter");
    await waitForTerminalOutput(page, marker1);

    await page.keyboard.type(`echo ${marker2}`);
    await page.keyboard.press("Enter");
    await waitForTerminalOutput(page, marker2);
  });

  test("Buffer replays on page reload", async ({ page }) => {
    const marker = `reload_${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await waitForTerminalOutput(page, marker);

    await page.reload();
    await waitForAppReady(page);

    // After reload the server replays the terminal scrollback buffer.
    // Wait for window.__xterm to be set (happens in term.open() → app.js),
    // then check the replayed buffer for the marker.
    await waitForTerminalOutput(page, marker);
  });
});
