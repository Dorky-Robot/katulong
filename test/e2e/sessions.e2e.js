import { test, expect } from "@playwright/test";

test.describe("Session manager modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");
    await page.locator("#shortcut-bar .session-btn").click();
    await expect(page.locator("#session-overlay")).toHaveClass(/visible/);
  });

  test("Opens when session button is clicked", async ({ page }) => {
    await expect(page.locator("#session-panel h3")).toHaveText("Sessions");
  });

  test("New session input and create button are present", async ({ page }) => {
    await expect(page.locator("#session-new-name")).toBeVisible();
    await expect(page.locator("#session-new-create")).toBeVisible();
  });

  test("Clicking outside closes the modal", async ({ page }) => {
    await page.locator("#session-overlay").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("#session-overlay")).not.toHaveClass(/visible/);
  });

  test("Session list shows current session with (current) tag", async ({ page }) => {
    const currentTag = page.locator(".session-current-tag");
    await expect(currentTag).toBeVisible();
    await expect(currentTag).toHaveText("(current)");
  });

  test("Session list shows alive status dot", async ({ page }) => {
    const statusDot = page.locator(".session-status.alive").first();
    await expect(statusDot).toBeVisible();
  });
});
