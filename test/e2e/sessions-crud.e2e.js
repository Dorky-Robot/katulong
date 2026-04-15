import { test, expect } from "@playwright/test";
import { waitForShellReady, cleanupSession } from './helpers.js';

test.describe("Session CRUD", () => {
  // Helper: create a session by navigating to it (triggers session create/attach)
  async function createSessionByNav(page, name) {
    await page.goto(`/?s=${encodeURIComponent(name)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await waitForShellReady(page);
  }

  const deleteSession = cleanupSession;

  test("Create session via tab bar + dropdown", async ({ page }) => {
    await page.goto("/");
    await waitForShellReady(page);

    // Click + button to open dropdown, then "New session"
    await page.locator("#shortcut-bar .tab-bar-add").click();
    await page.locator(".tab-context-menu .tab-menu-item", { hasText: "New session" }).click();

    // URL should change to include the new session name (starts with "session-")
    await page.waitForFunction(
      () => window.location.search.includes("s=session-"),
      { timeout: 5000 }
    );
    const newName = new URL(page.url()).searchParams.get("s");
    expect(newName).toBeTruthy();
    expect(newName).toMatch(/^session-/);

    // New tab should appear in tab bar as active
    const newTab = page.locator(`#shortcut-bar .tab-bar-tab.active`);
    await expect(newTab).toContainText(newName, { timeout: 5000 });

    // Cleanup
    await deleteSession(page, newName);
  });

  test("Detach session via close button removes tab", async ({ page }) => {
    const name = `test-detach-${Date.now()}`;

    // Create a session
    await createSessionByNav(page, name);

    // Go back to default
    await page.goto("/?s=default");
    await waitForShellReady(page);

    // Wait for the created session tab to appear
    const targetTab = page.locator(`#shortcut-bar .tab-bar-tab[data-session="${name}"]`);
    await expect(targetTab).toBeVisible({ timeout: 10000 });

    // Hover to reveal close button, then click it to detach
    await targetTab.hover();
    await targetTab.locator(".tab-close").click();

    // Tab should disappear
    await expect(targetTab).not.toBeVisible({ timeout: 10000 });

    // Cleanup
    await deleteSession(page, name);
  });

  test("Reattach detached session via + dropdown", async ({ page }) => {
    const name = `test-reattach-${Date.now()}`;

    // Create a session and let shell start
    await createSessionByNav(page, name);

    // Go to default first so we can detach the test session via close button
    await page.goto("/?s=default");
    await waitForShellReady(page);

    // Wait for the created session tab to appear
    const targetTab = page.locator(`#shortcut-bar .tab-bar-tab[data-session="${name}"]`);
    await expect(targetTab).toBeVisible({ timeout: 10000 });

    // Hover to reveal close button, then click × to detach
    await targetTab.hover();
    await targetTab.locator(".tab-close").click();

    // Tab should disappear
    await expect(targetTab).not.toBeVisible({ timeout: 10000 });

    // Click + to open dropdown — detached session should appear
    // (showAddMenu fetches fresh unmanaged sessions from the server)
    await page.locator("#shortcut-bar .tab-bar-add").click();
    const menu = page.locator(".tab-context-menu");
    await expect(menu).toBeVisible();
    const attachItem = menu.locator(".tab-menu-item", { hasText: name });
    await expect(attachItem).toBeVisible({ timeout: 5000 });

    // Click to reattach
    await attachItem.click();

    // Should switch to the reattached session
    await page.waitForURL(`**/?s=${encodeURIComponent(name)}`, { timeout: 5000 });

    // Tab should now be in the bar
    await expect(page.locator(`#shortcut-bar .tab-bar-tab[data-session="${name}"]`)).toBeVisible({ timeout: 10000 });

    // Cleanup
    await deleteSession(page, name);
  });

  test("Kill session via context menu removes tab and tmux session", async ({ page }) => {
    const name = `test-kill-${Date.now()}`;
    await page.goto("/");
    await waitForShellReady(page);

    // Create a second session
    await createSessionByNav(page, name);

    // Go back to default
    await page.goto("/");
    await waitForShellReady(page);

    // Wait for the created session tab to appear
    const targetTab = page.locator(`#shortcut-bar .tab-bar-tab[data-session="${name}"]`);
    await expect(targetTab).toBeVisible({ timeout: 10000 });

    // Right-click the tab to open context menu
    await targetTab.click({ button: "right" });

    // Click "Kill session" (accept the confirm dialog)
    page.on("dialog", (dialog) => dialog.accept());
    const killItem = page.locator(".tab-context-menu .tab-menu-item.danger", { hasText: "Kill" });
    await expect(killItem).toBeVisible();
    await killItem.click();

    // Tab should disappear
    await expect(targetTab).not.toBeVisible({ timeout: 10000 });

    // tmux session should NOT exist anymore
    const tmuxSessions = await page.evaluate(() =>
      fetch("/tmux-sessions").then(r => r.json())
    );
    expect(tmuxSessions).not.toContain(name);
  });

  test("Delete session via API and tab disappears", async ({ page }) => {
    const name = `test-delete-${Date.now()}`;

    // Create session
    await createSessionByNav(page, name);

    // Go back to default session
    await page.goto("/?s=default");
    await waitForShellReady(page);

    // Verify the created session tab exists
    await expect(page.locator(`#shortcut-bar .tab-bar-tab[data-session="${name}"]`)).toBeVisible({ timeout: 10000 });

    // Delete via API
    await deleteSession(page, name);

    // Force session store refresh by navigating
    await page.goto("/?s=default");
    await waitForShellReady(page);

    // The deleted session tab should be gone
    await expect(page.locator(`#shortcut-bar .tab-bar-tab[data-session="${name}"]`)).not.toBeVisible({ timeout: 10000 });
  });

  test("Switch session via URL", async ({ page }) => {
    const name = `test-switch-${Date.now()}`;

    // Navigate directly to a named session URL
    await page.goto(`/?s=${encodeURIComponent(name)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await waitForShellReady(page);

    // Verify URL has the session name
    expect(new URL(page.url()).searchParams.get("s")).toBe(name);

    // Verify the session tab appears (tab bar renders async after session store loads)
    const sessionTab = page.locator(`#shortcut-bar .tab-bar-tab[data-session="${name}"]`);
    await expect(sessionTab).toBeVisible({ timeout: 10000 });

    // Verify terminal is functional
    await expect(page.locator(".xterm-rows")).not.toHaveText("");

    // Cleanup
    await deleteSession(page, name);
  });

  test("Switch session via tab click", async ({ page }) => {
    const name = `test-tab-${Date.now()}`;
    await page.goto("/");
    await waitForShellReady(page);

    // Create a second session
    await createSessionByNav(page, name);

    // Go back to default
    await page.goto("/?s=default");
    await waitForShellReady(page);

    // Wait for our test session tab to appear
    const targetTab = page.locator(`#shortcut-bar .tab-bar-tab[data-session="${name}"]`);
    await expect(targetTab).toBeVisible({ timeout: 10000 });

    // Click the test session tab
    await targetTab.click();

    // URL should update to our session
    await page.waitForURL(`**/?s=${encodeURIComponent(name)}`, { timeout: 5000 });

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

    // Type marker in session A
    await createSessionByNav(page, nameA);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(`echo ${markerA}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(markerA, { timeout: 5000 });

    // Type marker in session B
    await createSessionByNav(page, nameB);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(`echo ${markerB}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(markerB, { timeout: 5000 });

    // Session B should NOT contain marker A
    const textB = await page.locator(".xterm-rows").textContent();
    expect(textB).not.toContain(markerA);

    // Cleanup
    await deleteSession(page, nameA);
    await deleteSession(page, nameB);
  });
});
