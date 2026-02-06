import { test, expect } from "@playwright/test";

test.describe("Settings modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/visible/);
  });

  test("Opens when gear icon is clicked", async ({ page }) => {
    // beforeEach already verified this
    await expect(page.locator("#settings-panel h3")).toHaveText("Settings");
  });

  test("Theme toggle has Auto, Light, and Dark buttons", async ({ page }) => {
    const toggle = page.locator(".theme-toggle");
    await expect(toggle.locator("button[data-theme-val='auto']")).toBeVisible();
    await expect(toggle.locator("button[data-theme-val='light']")).toBeVisible();
    await expect(toggle.locator("button[data-theme-val='dark']")).toBeVisible();
  });

  test("Theme toggle marks the active theme", async ({ page }) => {
    const activeBtn = page.locator(".theme-toggle button.active");
    await expect(activeBtn).toHaveCount(1);
  });

  test("Switching theme updates the active button", async ({ page }) => {
    await page.locator("button[data-theme-val='light']").click();
    await expect(page.locator("button[data-theme-val='light']")).toHaveClass(/active/);
    await expect(page.locator("button[data-theme-val='auto']")).not.toHaveClass(/active/);
  });

  test("Logout button is visible", async ({ page }) => {
    const logout = page.locator("#settings-logout");
    await expect(logout).toBeVisible();
    await expect(logout).toHaveText("Log Out");
  });

  test("No Done button exists", async ({ page }) => {
    const done = page.locator("#settings-done");
    await expect(done).toHaveCount(0);
  });

  test("Clicking outside closes the modal", async ({ page }) => {
    await page.locator("#settings-overlay").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("#settings-overlay")).not.toHaveClass(/visible/);
  });

  test("Logout button redirects to /login", async ({ page }) => {
    await page.locator("#settings-logout").click();
    await page.waitForURL("**/login");
    expect(page.url()).toContain("/login");
  });

  test("Theme persists after reload", async ({ page }) => {
    // Switch to light theme
    await page.locator("button[data-theme-val='light']").click();
    await expect(page.locator("button[data-theme-val='light']")).toHaveClass(/active/);

    // Close modal and reload
    await page.locator("#settings-overlay").click({ position: { x: 5, y: 5 } });
    await page.reload();
    await page.waitForSelector("#shortcut-bar");

    // Verify theme attribute persisted
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Re-open settings and verify active button state
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/visible/);
    await expect(page.locator("button[data-theme-val='light']")).toHaveClass(/active/);

    // Reset to auto
    await page.locator("button[data-theme-val='auto']").click();
  });
});
