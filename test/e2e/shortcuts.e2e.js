import { test, expect } from "@playwright/test";

test.describe("Shortcuts popup", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");
  });

  test("Clicking keyboard icon opens the shortcuts popup", async ({ page }) => {
    const kbBtn = page.locator("#shortcut-bar .bar-icon-btn[aria-label='Open shortcuts']");
    await kbBtn.click();
    const overlay = page.locator("#shortcuts-overlay");
    await expect(overlay).toHaveClass(/visible/);
  });

  test("Shortcut buttons have visible text (no blank labels)", async ({ page }) => {
    const kbBtn = page.locator("#shortcut-bar .bar-icon-btn[aria-label='Open shortcuts']");
    await kbBtn.click();
    await expect(page.locator("#shortcuts-overlay")).toHaveClass(/visible/);

    const buttons = page.locator("#shortcuts-grid .shortcut-btn");
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const text = await buttons.nth(i).textContent();
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  test("Edit button is present in the footer", async ({ page }) => {
    const kbBtn = page.locator("#shortcut-bar .bar-icon-btn[aria-label='Open shortcuts']");
    await kbBtn.click();
    const editBtn = page.locator("#shortcuts-edit-btn");
    await expect(editBtn).toBeVisible();
    await expect(editBtn).toContainText("Edit");
  });

  test("Closing the modal returns focus to terminal", async ({ page }) => {
    const kbBtn = page.locator("#shortcut-bar .bar-icon-btn[aria-label='Open shortcuts']");
    await kbBtn.click();
    await expect(page.locator("#shortcuts-overlay")).toHaveClass(/visible/);

    // Click overlay background to dismiss
    await page.locator("#shortcuts-overlay").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("#shortcuts-overlay")).not.toHaveClass(/visible/);

    // Terminal textarea should have focus
    const focused = page.locator(".xterm-helper-textarea");
    await expect(focused).toBeFocused();
  });
});
