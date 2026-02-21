import { test, expect } from "@playwright/test";
import { waitForAppReady, waitForTerminalOutput, termSend } from './helpers.js';

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
    // xterm auto-focuses it via term.focus() in app.js on page load; explicitly
    // calling .focus() again on mobile emulation activates IME autocorrect
    // behaviors that inject spurious characters ("clear"), and repeated focus
    // calls in serial mode can disrupt Playwright's keyboard routing.
    // Test bodies use termSend() (window.__termSend) instead of keyboard.type()
    // to bypass IME and keyboard-routing drift entirely.
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
    // Use termSend (window.__termSend) instead of page.keyboard.type() and
    // keyboard.press("Enter"). In serial mode, accumulated mobile IME state and
    // Playwright keyboard-routing drift across multiple page.goto() navigations
    // cause keyboard events to be lost or mangled. termSend bypasses keyboard
    // events entirely, sending directly to the PTY via the app's input sender.
    await termSend(page, `echo ${marker}\r`);
    await waitForTerminalOutput(page, marker);
  });

  test("Multiple commands produce sequential output", async ({ page }) => {
    const marker1 = `first_${Date.now()}`;
    const marker2 = `second_${Date.now()}`;

    await termSend(page, `echo ${marker1}\r`);
    await waitForTerminalOutput(page, marker1);

    await termSend(page, `echo ${marker2}\r`);
    await waitForTerminalOutput(page, marker2);
  });

  test("Buffer replays on page reload", async ({ page }) => {
    const marker = `reload_${Date.now()}`;
    // termSend bypasses keyboard events entirely, avoiding both mobile IME
    // autocorrect injection and the Playwright keyboard-routing drift that
    // occurs after multiple serial page.goto() navigations (where the
    // auto-focused xterm textarea is no longer tracked by the input system).
    // The \r (carriage return) is sent together with the command text so the
    // animation-frame batch in inputSender always delivers both in one send.
    await termSend(page, `echo ${marker}\r`);
    await waitForTerminalOutput(page, marker);

    await page.reload();
    await waitForAppReady(page);

    // After reload the server replays the terminal scrollback buffer.
    // Wait for window.__xterm to be set (happens in term.open() → app.js),
    // then check the replayed buffer for the marker.
    await waitForTerminalOutput(page, marker);
  });
});
