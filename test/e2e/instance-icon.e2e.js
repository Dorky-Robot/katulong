import { test, expect } from "@playwright/test";

test.describe("Instance Icon Picker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");
  });

  test("Instance icon button exists in Settings > Theme tab", async ({ page }) => {
    // Open settings
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/visible/);

    // Verify Theme tab is active by default
    await expect(page.locator("#settings-tab-theme")).toHaveClass(/active/);

    // Verify instance icon button exists
    const iconBtn = page.locator("#instance-icon-btn");
    await expect(iconBtn).toBeVisible();
    await expect(iconBtn).toContainText("Change");
  });

  test("Clicking Change opens icon picker modal", async ({ page }) => {
    // Open settings
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/visible/);

    // Click Change button
    await page.locator("#instance-icon-btn").click();

    // Verify icon picker modal appears
    const overlay = page.locator("#icon-picker-overlay");
    await expect(overlay).toBeVisible();
    await expect(page.locator(".icon-picker-modal h3")).toHaveText("Choose an Icon");
  });

  test("Icon picker displays all categories with icons", async ({ page }) => {
    // Open settings and icon picker
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await page.locator("#instance-icon-btn").click();

    // Verify categories
    await expect(page.locator(".icon-picker-category")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "Computers & Devices" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Objects & Symbols" })).toBeVisible();

    // Verify each category has icons
    const categories = await page.locator(".icon-picker-category").all();
    for (const category of categories) {
      const icons = await category.locator(".icon-picker-icon").count();
      expect(icons).toBeGreaterThan(0);
    }
  });

  test("Clicking close button closes the modal", async ({ page }) => {
    // Open settings and icon picker
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await page.locator("#instance-icon-btn").click();

    // Verify modal is open
    await expect(page.locator("#icon-picker-overlay")).toBeVisible();

    // Click close button
    await page.locator("#icon-picker-close").click();

    // Verify modal is closed
    await expect(page.locator("#icon-picker-overlay")).toBeHidden();
  });

  test("Clicking outside modal closes it", async ({ page }) => {
    // Open settings and icon picker
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await page.locator("#instance-icon-btn").click();

    // Verify modal is open
    await expect(page.locator("#icon-picker-overlay")).toBeVisible();

    // Click outside (on overlay background)
    await page.locator("#icon-picker-overlay").click({ position: { x: 5, y: 5 } });

    // Verify modal is closed
    await expect(page.locator("#icon-picker-overlay")).toBeHidden();
  });

  test("Selecting an icon updates the display and closes modal", async ({ page }) => {
    // Open settings and icon picker
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await page.locator("#instance-icon-btn").click();

    // Get the initial icon
    const iconDisplay = page.locator("#instance-icon-display");
    const initialClass = await iconDisplay.getAttribute("class");

    // Select a different icon (laptop from Computers & Devices)
    const laptopIcon = page.locator(".icon-picker-icon[data-icon='laptop']");
    await laptopIcon.click();

    // Wait for modal to close
    await expect(page.locator("#icon-picker-overlay")).toBeHidden();

    // Verify icon updated in settings
    const newClass = await iconDisplay.getAttribute("class");
    expect(newClass).not.toBe(initialClass);
    expect(newClass).toContain("ph-laptop");
  });

  test("Selected icon appears in shortcut bar session button", async ({ page }) => {
    // Open settings and icon picker
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await page.locator("#instance-icon-btn").click();

    // Select house icon
    await page.locator(".icon-picker-icon[data-icon='house']").click();

    // Close settings modal
    await page.locator("#settings-overlay").click({ position: { x: 5, y: 5 } });

    // Verify house icon appears in session button
    const sessionBtn = page.locator(".session-btn");
    await expect(sessionBtn.locator(".ph-house")).toBeVisible();
  });

  test("Selected icon persists after page reload", async ({ page }) => {
    // Open settings and icon picker
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await page.locator("#instance-icon-btn").click();

    // Select desktop icon
    await page.locator(".icon-picker-icon[data-icon='desktop-tower']").click();

    // Reload page
    await page.reload();
    await page.waitForSelector("#shortcut-bar");

    // Verify desktop icon appears in session button
    const sessionBtn = page.locator(".session-btn");
    await expect(sessionBtn.locator(".ph-desktop-tower")).toBeVisible();

    // Open settings again and verify icon is still selected
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    const iconDisplay = page.locator("#instance-icon-display");
    const iconClass = await iconDisplay.getAttribute("class");
    expect(iconClass).toContain("ph-desktop-tower");

    // Reset to default (terminal-window)
    await page.locator("#instance-icon-btn").click();
    await page.locator(".icon-picker-icon[data-icon='terminal-window']").click();
  });

  test("Current icon is marked as selected in picker", async ({ page }) => {
    // Set an icon first
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await page.locator("#instance-icon-btn").click();
    await page.locator(".icon-picker-icon[data-icon='laptop']").click();

    // Re-open icon picker
    await page.locator("#instance-icon-btn").click();

    // Verify laptop icon has selected class
    const laptopIcon = page.locator(".icon-picker-icon[data-icon='laptop']");
    await expect(laptopIcon).toHaveClass(/selected/);

    // Verify other icons don't have selected class
    const houseIcon = page.locator(".icon-picker-icon[data-icon='house']");
    await expect(houseIcon).not.toHaveClass(/selected/);

    // Reset to default
    await page.locator(".icon-picker-icon[data-icon='terminal-window']").click();
  });

  test("Icon picker modal has higher z-index than settings modal", async ({ page }) => {
    // Open settings
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Settings']").click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/visible/);

    // Get z-index of settings overlay
    const settingsZIndex = await page.locator("#settings-overlay").evaluate(
      el => window.getComputedStyle(el).zIndex
    );

    // Open icon picker
    await page.locator("#instance-icon-btn").click();

    // Get z-index of icon picker overlay
    const pickerZIndex = await page.locator("#icon-picker-overlay").evaluate(
      el => window.getComputedStyle(el).zIndex
    );

    // Verify icon picker is above settings modal
    expect(parseInt(pickerZIndex)).toBeGreaterThan(parseInt(settingsZIndex));
  });
});
