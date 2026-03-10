import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { waitForShellReady } from './helpers.js';

test.describe("Session CRUD", () => {
  // Helper: create a session by navigating to it (triggers session create/attach)
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

  test("Create session via + button", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Open session sidebar
    await page.locator("#shortcut-bar .session-btn").click();
    await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

    // Click + to create new session
    await page.locator("#sidebar-add-btn").click();

    // URL should change to include the new session name (starts with "session-")
    await page.waitForFunction(
      () => window.location.search.includes("s=session-"),
      { timeout: 5000 }
    );
    const newName = new URL(page.url()).searchParams.get("s");
    expect(newName).toBeTruthy();
    expect(newName).toMatch(/^session-/);

    // Terminal should be functional
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });

    // Cleanup
    await deleteSession(page, newName);
  });

  test("Delete session via sidebar", async ({ page }) => {
    const name = `test-delete-${Date.now()}`;
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Create session by navigating to it (triggers session create on attach)
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

    // Create session by navigating to it (triggers session create on attach)
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

    // Navigate to session (creates it via session attach)
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

  test("Unmanaged tmux sessions appear in sidebar and can be adopted", async ({ page }) => {
    const tmuxName = `unmanaged-e2e-${Date.now()}`;

    // Create a tmux session outside of katulong
    execSync(`tmux new-session -d -s ${tmuxName}`);

    try {
      await page.goto("/");
      await page.waitForSelector("#shortcut-bar");

      // Open sidebar
      await page.locator("#shortcut-bar .session-btn").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Unmanaged session should appear with .unmanaged class
      const unmanagedCard = page.locator(`.session-card.unmanaged`, {
        has: page.locator(`text=${tmuxName}`),
      });
      await expect(unmanagedCard).toBeVisible({ timeout: 10000 });

      // Click to adopt
      await unmanagedCard.click();

      // After adoption, it should appear as a managed session (no .unmanaged class)
      const managedCard = page.locator(`.session-card:not(.unmanaged)`, {
        has: page.getByLabel(`Session name: ${tmuxName}`),
      });
      await expect(managedCard).toBeVisible({ timeout: 10000 });

      // The unmanaged card should be gone
      await expect(unmanagedCard).not.toBeVisible();
    } finally {
      // Cleanup: delete via katulong API first, then kill tmux session as fallback
      await deleteSession(page, tmuxName);
      try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`); } catch {}
    }
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

    // Type marker in session A (creates it via session attach)
    await page.goto(`/?s=${encodeURIComponent(nameA)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await waitForShellReady(page);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(`echo ${markerA}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(markerA);

    // Type marker in session B (creates it via session attach)
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
