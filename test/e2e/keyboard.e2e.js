import { test, expect } from "@playwright/test";

test.describe("Keyboard handling", () => {
  test.beforeEach(async ({ page }) => {
    // Capture outgoing input messages from both WebSocket and P2P DataChannel
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

    await page.goto("/");
    await page.waitForSelector(".xterm-helper-textarea");
    await page.locator(".xterm-helper-textarea").focus();
    // Wait for attach + P2P handshake to settle
    await page.waitForTimeout(1000);
    await page.evaluate(() => { window.__inputsSent = []; });
  });

  test("Shift+Enter sends quoted-insert + newline (\\x16\\x0a)", async ({ page }) => {
    await page.keyboard.press("Shift+Enter");
    await page.waitForTimeout(300);

    const inputs = await page.evaluate(() => window.__inputsSent);
    expect(inputs.length).toBeGreaterThan(0);
    const combined = inputs.join("");
    // The key behavior: Shift+Enter must send \x16\x0a (quoted-insert + newline)
    expect(combined).toContain("\x16\x0a");
  });

  test("Plain Enter sends carriage return (\\r) without quoted-insert", async ({ page }) => {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    const inputs = await page.evaluate(() => window.__inputsSent);
    expect(inputs.length).toBeGreaterThan(0);
    const combined = inputs.join("");
    expect(combined).toContain("\r");
    // Plain Enter must NOT trigger the quoted-insert sequence
    expect(combined).not.toContain("\x16");
  });

  test("Tab sends \\t to the terminal", async ({ page }) => {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);

    const inputs = await page.evaluate(() => window.__inputsSent);
    expect(inputs.length).toBeGreaterThan(0);
    const combined = inputs.join("");
    expect(combined).toContain("\t");
  });
});
