import { test, expect } from "@playwright/test";

test.describe("Toolbar layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");
  });

  test("P2P indicator dot is the first child of the shortcut bar", async ({ page }) => {
    const first = page.locator("#shortcut-bar > :first-child");
    await expect(first).toHaveId("p2p-indicator");
  });

  test("Session button is the second child", async ({ page }) => {
    const second = page.locator("#shortcut-bar > :nth-child(2)");
    await expect(second).toHaveClass(/session-btn/);
  });

  test("Esc button is present", async ({ page }) => {
    const esc = page.locator("#shortcut-bar .shortcut-btn", { hasText: "Esc" });
    await expect(esc).toBeVisible();
  });

  test("No arrow key buttons exist in the bar", async ({ page }) => {
    for (const arrow of ["\u2190", "\u2192", "\u2191", "\u2193"]) {
      const btn = page.locator("#shortcut-bar button", { hasText: arrow });
      await expect(btn).toHaveCount(0);
    }
  });

  test("Keyboard and settings icon buttons are present", async ({ page }) => {
    const kbBtn = page.locator("#shortcut-bar .bar-icon-btn[aria-label='Open shortcuts']");
    const setBtn = page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']");
    await expect(kbBtn).toBeVisible();
    await expect(setBtn).toBeVisible();
  });

  test("Order: dot, session, spacer, Esc, keyboard, settings", async ({ page }) => {
    const children = page.locator("#shortcut-bar > *");
    const count = await children.count();
    expect(count).toBeGreaterThanOrEqual(6);

    // 0: p2p-indicator
    await expect(children.nth(0)).toHaveId("p2p-indicator");
    // 1: session-btn
    await expect(children.nth(1)).toHaveClass(/session-btn/);
    // 2: bar-spacer
    await expect(children.nth(2)).toHaveClass(/bar-spacer/);
    // 3: Esc shortcut-btn
    await expect(children.nth(3)).toHaveClass(/shortcut-btn/);
    await expect(children.nth(3)).toHaveText("Esc");
    // 4: keyboard bar-icon-btn
    await expect(children.nth(4)).toHaveClass(/bar-icon-btn/);
    await expect(children.nth(4)).toHaveAttribute("aria-label", "Open shortcuts");
    // 5: settings bar-icon-btn
    await expect(children.nth(5)).toHaveClass(/bar-icon-btn/);
    await expect(children.nth(5)).toHaveAttribute("aria-label", "Settings");
  });
});
