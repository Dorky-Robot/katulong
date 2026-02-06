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

  test("Comma-separated sequence shortcut shows correct label", async ({ page }) => {
    // Open shortcuts popup → Edit → Add
    const kbBtn = page.locator("#shortcut-bar .bar-icon-btn[aria-label='Open shortcuts']");
    await kbBtn.click();
    await expect(page.locator("#shortcuts-overlay")).toHaveClass(/visible/);

    await page.locator("#shortcuts-edit-btn").click();
    await expect(page.locator("#edit-overlay")).toHaveClass(/visible/);

    await page.locator("#edit-add").click();
    await expect(page.locator("#add-modal-overlay")).toHaveClass(/visible/);

    const input = page.locator("#key-composer-input");

    // Type "ctrl" + Enter, "c" + Enter, "," + Enter, "ctrl" + Enter, "c" + Enter
    await input.fill("ctrl");
    await input.press("Enter");
    await input.fill("c");
    await input.press("Enter");
    await input.fill(",");
    await input.press("Enter");
    await input.fill("ctrl");
    await input.press("Enter");
    await input.fill("c");
    await input.press("Enter");

    // Preview should show "Ctrl+C, Ctrl+C"
    const preview = page.locator("#key-preview-value");
    await expect(preview).toHaveText("Ctrl+C, Ctrl+C");

    // Save the shortcut
    await page.locator("#modal-save").click();

    // The edit list should contain an item with the label
    const editList = page.locator("#edit-list");
    await expect(editList).toContainText("Ctrl+C, Ctrl+C");
  });
});

test.describe("Dictation modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");
  });

  test("Long-pressing the terminal opens the dictation panel", async ({ page }) => {
    const terminal = page.locator("#terminal-container");

    // Native long-press fires contextmenu
    await terminal.dispatchEvent("contextmenu");

    const overlay = page.locator("#dictation-overlay");
    await expect(overlay).toHaveClass(/visible/);

    const textarea = page.locator("#dictation-input");
    await expect(textarea).toBeVisible();

    const sendBtn = page.locator("#dictation-send");
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toHaveText("Send");
  });
});

test.describe("Joystick zone", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");
  });

  test("Joystick is visible only on mobile (pointer: coarse)", async ({ page, browserName }, testInfo) => {
    const joystick = page.locator("#joystick");
    if (testInfo.project.name === "mobile") {
      await expect(joystick).toBeVisible();
    } else {
      await expect(joystick).not.toBeVisible();
    }
  });
});
