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

    // Wait for the shell to return to the prompt before typing the next command.
    // On mobile, keyboard.type() during shell processing can trigger IME
    // autocorrect that injects spurious characters (e.g. "clear").
    await page.waitForFunction(
      () => /[$➜%#>]/.test(document.querySelector('.xterm-rows')?.textContent || ''),
      { timeout: 10000 },
    );

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
