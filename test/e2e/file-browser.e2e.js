import { test, expect } from "@playwright/test";
import { waitForAppReady, waitForShellReady } from "./helpers.js";

test.describe("File Browser", () => {
  let sessionName;

  test.beforeEach(async ({ page }, testInfo) => {
    sessionName = `fb-${testInfo.testId}-${Date.now()}`;
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await waitForAppReady(page);
    await page.locator(".xterm-helper-textarea").focus();
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      sessionName,
    );
  });

  test("File browser button is visible in shortcut bar", async ({ page }) => {
    const filesBtn = page.locator('button[aria-label="Open file browser"]').first();
    await expect(filesBtn).toBeVisible();
  });

  test("Opens file browser and shows columns", async ({ page }) => {
    // Click the file browser button in the shortcut bar
    await page.locator('button[aria-label="Open file browser"]').first().click();

    // File browser should be visible
    const fb = page.locator("#file-browser");
    await expect(fb).toHaveClass(/active/);

    // Terminal should be hidden
    const termContainer = page.locator("#terminal-container");
    await expect(termContainer).toHaveClass(/fb-hidden/);

    // Should have at least one column with entries
    await page.waitForSelector(".fb-miller-col", { timeout: 5000 });
    const columns = page.locator(".fb-miller-col");
    await expect(columns.first()).toBeVisible();

    // Should have rows in the first column
    const rows = page.locator(".fb-miller-row");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test("Clicking a folder drills into it", async ({ page }) => {
    await page.locator('button[aria-label="Open file browser"]').first().click();
    await page.waitForSelector(".fb-miller-col", { timeout: 5000 });

    // Find and click a directory row
    const dirRow = page.locator('.fb-miller-row[data-type="directory"]').first();
    await expect(dirRow).toBeVisible();
    const dirName = await dirRow.getAttribute("data-name");
    await dirRow.click();

    // Should now have a second column
    await page.waitForSelector(".fb-miller-col:nth-child(2)", { timeout: 5000 });
    const columns = page.locator(".fb-miller-col");
    const colCount = await columns.count();
    expect(colCount).toBeGreaterThanOrEqual(2);

    // The clicked row should be selected (highlighted)
    await expect(dirRow).toHaveClass(/fb-miller-selected/);
  });

  test("Folders show chevron indicator", async ({ page }) => {
    await page.locator('button[aria-label="Open file browser"]').first().click();
    await page.waitForSelector(".fb-miller-col", { timeout: 5000 });

    // Directories should have a chevron
    const dirRow = page.locator('.fb-miller-row[data-type="directory"]').first();
    if (await dirRow.count() > 0) {
      const chevron = dirRow.locator(".fb-miller-chevron");
      await expect(chevron).toBeVisible();
    }

    // Files should NOT have a chevron
    const fileRow = page.locator('.fb-miller-row[data-type="file"]').first();
    if (await fileRow.count() > 0) {
      const chevron = fileRow.locator(".fb-miller-chevron");
      await expect(chevron).toHaveCount(0);
    }
  });

  test("Close button returns to terminal", async ({ page }) => {
    await page.locator('button[aria-label="Open file browser"]').first().click();
    await page.waitForSelector(".fb-miller-col", { timeout: 5000 });

    // Click close button
    await page.locator('button[aria-label="Close file browser"]').click();

    // File browser should be hidden
    const fb = page.locator("#file-browser");
    await expect(fb).not.toHaveClass(/active/);

    // Terminal should be visible again
    const termContainer = page.locator("#terminal-container");
    await expect(termContainer).not.toHaveClass(/fb-hidden/);
  });

  test("Terminal session survives file browser toggle", async ({ page }) => {
    // Type something in the terminal first
    const marker = `fb_survive_${Date.now()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(marker);

    // Open file browser
    await page.locator('button[aria-label="Open file browser"]').first().click();
    await page.waitForSelector(".fb-miller-col", { timeout: 5000 });

    // Browse around - click a folder
    const dirRow = page.locator('.fb-miller-row[data-type="directory"]').first();
    if (await dirRow.count() > 0) {
      await dirRow.click();
      await page.waitForSelector(".fb-miller-col:nth-child(2)", { timeout: 5000 });
    }

    // Close file browser, return to terminal
    await page.locator('button[aria-label="Close file browser"]').click();
    await expect(page.locator("#terminal-container")).not.toHaveClass(/fb-hidden/);

    // Terminal should still work — type another command
    await page.locator(".xterm-helper-textarea").focus();
    const marker2 = `fb_after_${Date.now()}`;
    await page.keyboard.type(`echo ${marker2}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(marker2, { timeout: 10000 });
  });

  test("Breadcrumb shows current path", async ({ page }) => {
    await page.locator('button[aria-label="Open file browser"]').first().click();
    await page.waitForSelector(".fb-miller-col", { timeout: 5000 });

    // Breadcrumb should show at least "/"
    const breadcrumb = page.locator(".fb-breadcrumb");
    await expect(breadcrumb).toContainText("/");
  });

  test("Back button removes last column", async ({ page }) => {
    await page.locator('button[aria-label="Open file browser"]').first().click();
    await page.waitForSelector(".fb-miller-col", { timeout: 5000 });

    // Drill into a folder
    const dirRow = page.locator('.fb-miller-row[data-type="directory"]').first();
    if (await dirRow.count() === 0) {
      test.skip();
      return;
    }
    await dirRow.click();
    await page.waitForSelector(".fb-miller-col:nth-child(2)", { timeout: 5000 });

    const colsBefore = await page.locator(".fb-miller-col").count();

    // Click back
    await page.locator('button[aria-label="Go back"]').click();

    // Should have one fewer column
    const colsAfter = await page.locator(".fb-miller-col").count();
    expect(colsAfter).toBeLessThan(colsBefore);
  });

  test("Status bar shows item count", async ({ page }) => {
    await page.locator('button[aria-label="Open file browser"]').first().click();
    await page.waitForSelector(".fb-miller-col", { timeout: 5000 });

    const status = page.locator(".fb-status");
    await expect(status).toContainText("item");
  });

  test("Context menu appears on right-click", async ({ page }) => {
    await page.locator('button[aria-label="Open file browser"]').first().click();
    await page.waitForSelector(".fb-miller-row", { timeout: 5000 });

    // Right-click on a row
    const row = page.locator(".fb-miller-row").first();
    await row.click({ button: "right" });

    // Context menu should appear
    const menu = page.locator(".fb-context-menu");
    await expect(menu).toBeVisible();

    // Click elsewhere to dismiss
    await page.locator(".fb-columns").click({ position: { x: 5, y: 5 } });
    await expect(menu).not.toBeVisible();
  });

  test("File browser API returns directory listing", async ({ page }) => {
    const response = await page.evaluate(() =>
      fetch("/api/files").then(r => r.json())
    );
    expect(response.path).toBeTruthy();
    expect(Array.isArray(response.entries)).toBe(true);
    expect(response.entries.length).toBeGreaterThan(0);
    // Each entry should have required fields
    const entry = response.entries[0];
    expect(entry.name).toBeTruthy();
    expect(["file", "directory"]).toContain(entry.type);
    expect(entry.kind).toBeTruthy();
  });

  test("File browser API rejects path traversal", async ({ page }) => {
    const response = await page.evaluate(() =>
      fetch("/api/files?path=/etc/../etc/passwd").then(r => ({ status: r.status }))
    );
    expect(response.status).toBe(400);
  });

  test("Global drop overlay does not appear when file browser is active", async ({ page }) => {
    await page.locator('button[aria-label="Open file browser"]').first().click();
    await page.waitForSelector(".fb-miller-col", { timeout: 5000 });

    // Simulate dragenter on the page
    await page.evaluate(() => {
      const event = new DragEvent("dragenter", {
        bubbles: true,
        dataTransfer: new DataTransfer(),
      });
      document.querySelector(".fb-columns").dispatchEvent(event);
    });

    // The global "Drop image here" overlay should NOT be visible
    const dropOverlay = page.locator("#drop-overlay");
    await expect(dropOverlay).not.toHaveClass(/visible/);
  });
});
