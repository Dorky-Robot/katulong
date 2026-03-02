import { test, expect } from "@playwright/test";
import { waitForShellReady } from './helpers.js';

test.describe("Session CRUD", () => {
  // Helper: create a session by navigating to it (triggers daemon attach/create)
  async function createSessionByNav(page, name) {
    await page.goto(`/?s=${encodeURIComponent(name)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await waitForShellReady(page);
  }

  // Helper: delete a session via API (best-effort cleanup)
  async function deleteSession(page, name) {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      name,
    );
  }

  test("Create session via sidebar", async ({ page, context }) => {
    const name = `test-create-${Date.now()}`;
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Open session sidebar and create
    await page.locator("#shortcut-bar .session-btn").click();
    await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);
    await page.locator("#session-new-name").fill(name);

    // Capture the new tab that opens on create
    // window.open may be blocked in headless browsers, so handle both cases
    const pagePromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.locator("#session-new-create").click();
    const newPage = await pagePromise;

    if (newPage) {
      await newPage.waitForLoadState();
      expect(newPage.url()).toContain(`?s=${encodeURIComponent(name)}`);

      // Verify terminal is functional in new tab
      await newPage.waitForSelector(".xterm-helper-textarea");
      await newPage.waitForSelector(".xterm-screen", { timeout: 5000 });
      await newPage.locator(".xterm-helper-textarea").focus();
      await expect(newPage.locator(".xterm-rows")).not.toHaveText("");
      await newPage.close();
    } else {
      // Popup blocked — verify session was created via daemon list
      const res = await page.evaluate(() => fetch("/sessions").then(r => r.json()));
      const created = res.some(s => s.name === name);
      expect(created).toBe(true);
    }

    // Cleanup
    await deleteSession(page, name);
  });

  test("Delete session via sidebar", async ({ page }) => {
    const name = `test-delete-${Date.now()}`;
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Create session by navigating to it (triggers daemon create on attach)
    await createSessionByNav(page, name);

    // Go back to default session
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Open session sidebar — list fetches on open
    await page.locator("#shortcut-bar .session-btn").click();
    await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

    // Wait for the session list to load and find the card
    const card = page.locator(".session-card", {
      has: page.getByLabel(`Session name: ${name}`),
    });
    await expect(card).toBeVisible({ timeout: 10000 });

    // Handle potential confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    // Hover to reveal action buttons, then click delete
    await card.hover();
    await card.locator(".session-card-action.delete").click();

    // Verify removed from list
    await expect(card).not.toBeVisible();
  });

  test("Rename session via sidebar", async ({ page }) => {
    const name = `test-rename-${Date.now()}`;
    const newName = `renamed-${Date.now()}`;
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Create session by navigating to it (triggers daemon create on attach)
    await createSessionByNav(page, name);

    // Go back to default session
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Open session sidebar and rename
    await page.locator("#shortcut-bar .session-btn").click();
    await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

    // Wait for session list to load, double-click to enable editing
    const nameInput = page.getByLabel(`Session name: ${name}`);
    await expect(nameInput).toBeVisible({ timeout: 10000 });
    await nameInput.dblclick();
    await nameInput.fill(newName);
    await nameInput.press("Enter");

    // Verify new name appears in list (re-rendered after rename)
    await expect(page.getByLabel(`Session name: ${newName}`)).toBeVisible({ timeout: 10000 });

    // Cleanup
    await deleteSession(page, newName);
  });

  test("Switch session via URL", async ({ page }) => {
    const name = `test-switch-${Date.now()}`;
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Navigate to session (creates it via daemon attach)
    await page.goto(`/?s=${encodeURIComponent(name)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await page.locator(".xterm-helper-textarea").focus();

    // Verify session button shows the session name
    await expect(page.locator("#shortcut-bar .session-btn")).toContainText(
      name,
    );

    // Verify terminal is functional
    await expect(page.locator(".xterm-rows")).not.toHaveText("");

    // Cleanup
    await deleteSession(page, name);
  });

  test("Session isolation — markers do not bleed across sessions", async ({
    page,
  }) => {
    const nameA = `iso-a-${Date.now()}`;
    const nameB = `iso-b-${Date.now()}`;
    const markerA = `ISOA_${Date.now()}`;
    const markerB = `ISOB_${Date.now()}`;

    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Type marker in session A (creates it via daemon attach)
    await page.goto(`/?s=${encodeURIComponent(nameA)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await waitForShellReady(page);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(`echo ${markerA}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(markerA);

    // Type marker in session B (creates it via daemon attach)
    await page.goto(`/?s=${encodeURIComponent(nameB)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await waitForShellReady(page);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(`echo ${markerB}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(markerB);

    // Session B should NOT contain marker A
    const textB = await page.locator(".xterm-rows").textContent();
    expect(textB).not.toContain(markerA);

    // Go back to session A — buffer replay should show marker A but not B
    await page.goto(`/?s=${encodeURIComponent(nameA)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await expect(page.locator(".xterm-rows")).toContainText(markerA);
    const textA = await page.locator(".xterm-rows").textContent();
    expect(textA).not.toContain(markerB);

    // Cleanup
    await deleteSession(page, nameA);
    await deleteSession(page, nameB);
  });
});
