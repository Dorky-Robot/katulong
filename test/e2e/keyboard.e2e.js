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
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await page.locator(".xterm-helper-textarea").focus();
    // Wait for attach + P2P handshake to settle
    await page.waitForFunction(() => {
      // Wait for WebSocket or P2P to be ready
      return window.ws?.readyState === WebSocket.OPEN ||
             (window.pc?.connectionState === 'connected');
    }, { timeout: 5000 }).catch(() => {
      // Connection might already be established
    });
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
