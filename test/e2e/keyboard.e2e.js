import { test, expect } from "@playwright/test";
import { setupTest } from "./helpers.js";

test.describe("Keyboard handling", () => {
  test.beforeEach(async ({ page, context }) => {
    // Capture outgoing input messages from WebSocket
    await page.addInitScript(() => {
      window.__inputsSent = [];
      const origWsSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "input") window.__inputsSent.push(msg.data);
        } catch {}
        return origWsSend.call(this, data);
      };
      const origDcSend = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (data) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "input") window.__inputsSent.push(msg.data);
        } catch {}
        return origDcSend.call(this, data);
      };
    });

    // Use standard setup
    await setupTest({ page, context });

    // Focus terminal for keyboard input
    await page.click(".xterm");

    // Clear inputs array after setup
    await page.evaluate(() => { window.__inputsSent = []; });
  });

  test("Shift+Enter sends quoted-insert + newline (\\x16\\x0a)", async ({ page }) => {
    await page.keyboard.press("Shift+Enter");

    // Wait for input to be sent
    await page.waitForFunction(
      () => window.__inputsSent && window.__inputsSent.length > 0,
      { timeout: 1000 }
    );

    const inputs = await page.evaluate(() => window.__inputsSent);
    expect(inputs.length).toBeGreaterThan(0);
    const combined = inputs.join("");
    // The key behavior: Shift+Enter must send \x16\x0a (quoted-insert + newline)
    expect(combined).toContain("\x16\x0a");
  });

  test("Plain Enter sends carriage return (\\r) without quoted-insert", async ({ page }) => {
    await page.keyboard.press("Enter");

    // Wait for input to be sent
    await page.waitForFunction(
      () => window.__inputsSent && window.__inputsSent.length > 0,
      { timeout: 1000 }
    );

    const inputs = await page.evaluate(() => window.__inputsSent);
    expect(inputs.length).toBeGreaterThan(0);
    const combined = inputs.join("");
    expect(combined).toContain("\r");
    // Plain Enter must NOT trigger the quoted-insert sequence
    expect(combined).not.toContain("\x16");
  });

  test("Tab sends \\t to the terminal", async ({ page }) => {
    await page.keyboard.press("Tab");

    // Wait for input to be sent
    await page.waitForFunction(
      () => window.__inputsSent && window.__inputsSent.length > 0,
      { timeout: 1000 }
    );

    const inputs = await page.evaluate(() => window.__inputsSent);
    expect(inputs.length).toBeGreaterThan(0);
    const combined = inputs.join("");
    expect(combined).toContain("\t");
  });
});
