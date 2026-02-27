import { test, expect } from "@playwright/test";
import { setupTest, waitForShellReady } from './helpers.js';

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

  test("Create session via modal", async ({ page, context }) => {
    const name = `test-create-${Date.now()}`;
    await setupTest({ page, context });

    // Open session modal
    const sessionBtn = page.getByLabel(/Session:/);
    await sessionBtn.click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Sessions' });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Fill name and create
    await dialog.getByRole('textbox').fill(name);

    // Capture the new tab that opens on create
    const pagePromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await dialog.getByRole('button', { name: 'Create' }).click();
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

  test("Delete session via modal", async ({ page, context }) => {
    const name = `test-delete-${Date.now()}`;
    await setupTest({ page, context });

    // Create session by navigating to it (triggers daemon create on attach)
    await createSessionByNav(page, name);

    // Go back to default session
    await page.goto("/");
    await page.waitForSelector(".xterm", { timeout: 10000 });
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });

    // Open session modal
    const sessionBtn = page.getByLabel(/Session:/);
    await sessionBtn.click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Sessions' });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Wait for the session to appear in the list
    const sessionItem = dialog.getByText(name);
    await expect(sessionItem).toBeVisible({ timeout: 10000 });

    // Click delete button for this session's row
    // The delete button is a trash icon in the trailing position of the ListTile
    const row = dialog.locator(`[role="listitem"], li`).filter({ hasText: name });
    const deleteBtn = row.getByRole('button').last();
    await deleteBtn.click();

    // Verify removed from list
    await expect(sessionItem).not.toBeVisible({ timeout: 5000 });
  });

  test("Switch session via URL", async ({ page, context }) => {
    const name = `test-switch-${Date.now()}`;
    await setupTest({ page, context });

    // Navigate to session (creates it via daemon attach)
    await page.goto(`/?s=${encodeURIComponent(name)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await page.locator(".xterm-helper-textarea").focus();

    // Verify session button shows the session name
    await expect(page.getByLabel(`Session: ${name}`)).toBeVisible();

    // Verify terminal is functional
    await expect(page.locator(".xterm-rows")).not.toHaveText("");

    // Cleanup
    await deleteSession(page, name);
  });

  test("Session isolation — markers do not bleed across sessions", async ({
    page, context,
  }) => {
    const nameA = `iso-a-${Date.now()}`;
    const nameB = `iso-b-${Date.now()}`;
    const markerA = `ISOA_${Date.now()}`;
    const markerB = `ISOB_${Date.now()}`;

    await setupTest({ page, context });

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
