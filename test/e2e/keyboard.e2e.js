import { test, expect } from "@playwright/test";
import { waitForAppReady } from "./helpers.js";

test.describe("Keyboard handling", () => {
  // Serialize to avoid flakiness from concurrent tmux session creation
  test.describe.configure({ mode: "serial" });

  let sessionName;

  test.beforeEach(async ({ page, context }, testInfo) => {
    sessionName = `kb-${testInfo.testId}-${Date.now()}`;
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await waitForAppReady(page);
    await page.locator(".xterm-helper-textarea").focus();

    // Capture outgoing input messages by monkey-patching WebSocket.send
    // after the page (and its WS connection) is already established
    await page.evaluate(() => {
      window.__inputsSent = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "input") window.__inputsSent.push(msg.data);
        } catch {}
        return origSend.call(this, data);
      };
    });
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      sessionName,
    );
  });

  test("Shift+Enter sends bracketed paste with carriage return", async ({ page }) => {
    await page.keyboard.press("Shift+Enter");

    await page.waitForFunction(
      () => window.__inputsSent && window.__inputsSent.length > 0,
      { timeout: 3000 }
    );

    const inputs = await page.evaluate(() => window.__inputsSent);
    expect(inputs.length).toBeGreaterThan(0);
    const combined = inputs.join("");
    // Shift+Enter must send \r wrapped in bracketed paste markers so apps
    // like Claude Code treat it as a literal newline, not a submit action.
    expect(combined).toContain("\x1b[200~\r\x1b[201~");
  });

  test("Plain Enter sends carriage return (\\r) without bracketed paste", async ({ page }) => {
    await page.keyboard.press("Enter");

    await page.waitForFunction(
      () => window.__inputsSent && window.__inputsSent.length > 0,
      { timeout: 3000 }
    );

    const inputs = await page.evaluate(() => window.__inputsSent);
    expect(inputs.length).toBeGreaterThan(0);
    const combined = inputs.join("");
    expect(combined).toContain("\r");
    // Plain Enter must NOT trigger the bracketed paste sequence
    expect(combined).not.toContain("\x1b[200~");
  });

  test("Tab sends \\t to the terminal", async ({ page }) => {
    await page.keyboard.press("Tab");

    await page.waitForFunction(
      () => window.__inputsSent && window.__inputsSent.length > 0,
      { timeout: 3000 }
    );

    const inputs = await page.evaluate(() => window.__inputsSent);
    expect(inputs.length).toBeGreaterThan(0);
    const combined = inputs.join("");
    expect(combined).toContain("\t");
  });
});
