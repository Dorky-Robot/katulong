import { test, expect } from "@playwright/test";
import { waitForTerminalOutput, readTerminalBuffer } from './helpers.js';

test.describe("Session CRUD", () => {
  // Helper: delete a session via API (best-effort cleanup)
  async function deleteSession(page, name) {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      name,
    );
  }

  test("Create session via modal", async ({ page, context }) => {
    const name = `test-create-${Date.now()}`;
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Open session modal and create
    await page.locator("#shortcut-bar .session-btn").click();
    await expect(page.locator("#session-overlay")).toHaveClass(/visible/);
    await page.locator("#session-new-name").fill(name);

    // Capture the new tab that opens on create
    const [newPage] = await Promise.all([
      context.waitForEvent("page"),
      page.locator("#session-new-create").click(),
    ]);
    await newPage.waitForLoadState();
    expect(newPage.url()).toContain(`?s=${encodeURIComponent(name)}`);

    // Verify terminal is functional in new tab
    await newPage.waitForSelector(".xterm-helper-textarea");
    await newPage.waitForSelector(".xterm-screen", { timeout: 5000 });
    await newPage.locator(".xterm-helper-textarea").focus();
    await expect(newPage.locator(".xterm-rows")).not.toHaveText("");

    // Cleanup
    await newPage.close();
    await deleteSession(page, name);
  });

  test("Delete session via modal", async ({ page }) => {
    const name = `test-delete-${Date.now()}`;
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Create session via API
    await page.evaluate(
      (n) =>
        fetch("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: n }),
        }),
      name,
    );

    // Open session modal — list fetches on open
    await page.locator("#shortcut-bar .session-btn").click();
    await expect(page.locator("#session-overlay")).toHaveClass(/visible/);

    // Find the row by the input's aria-label which is set as an HTML attribute
    const row = page.locator(".session-item", {
      has: page.getByLabel(`Session name: ${name}`),
    });
    await expect(row).toBeVisible();

    // Handle potential confirmation dialog
    page.on("dialog", (dialog) => dialog.accept());

    await row.locator(".session-icon-btn.delete").click();

    // Verify removed from list
    await expect(row).not.toBeVisible();
  });

  test("Rename session via modal", async ({ page }) => {
    const name = `test-rename-${Date.now()}`;
    const newName = `renamed-${Date.now()}`;
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Create session via API
    await page.evaluate(
      (n) =>
        fetch("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: n }),
        }),
      name,
    );

    // Open session modal and rename
    await page.locator("#shortcut-bar .session-btn").click();
    await expect(page.locator("#session-overlay")).toHaveClass(/visible/);

    const nameInput = page.getByLabel(`Session name: ${name}`);
    await expect(nameInput).toBeVisible();
    await nameInput.fill(newName);
    await nameInput.press("Enter");

    // Verify new name appears in list (re-rendered after rename)
    await expect(page.getByLabel(`Session name: ${newName}`)).toBeVisible();

    // Cleanup
    await deleteSession(page, newName);
  });

  test("Switch session via URL", async ({ page }) => {
    const name = `test-switch-${Date.now()}`;
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");

    // Create session via API
    await page.evaluate(
      (n) =>
        fetch("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: n }),
        }),
      name,
    );

    // Navigate to that session
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

    // Create both sessions via API
    for (const n of [nameA, nameB]) {
      await page.evaluate(
        (n) =>
          fetch("/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: n }),
          }),
        n,
      );
    }

    // Helper: wait for shell prompt before typing to avoid init-script interference
    const waitForPrompt = () =>
      page.waitForFunction(
        () => /[$➜%#>]/.test(document.querySelector('.xterm-rows')?.textContent || ''),
        { timeout: 10000 },
      );

    // Type marker in session A
    await page.goto(`/?s=${encodeURIComponent(nameA)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await waitForPrompt();
    // Do NOT explicitly focus the textarea — xterm auto-focuses it on page
    // load, and explicit re-focus on mobile activates IME autocorrect.
    await page.keyboard.type(`echo ${markerA}`);
    await page.keyboard.press("Enter");
    // Use xterm's internal buffer rather than .xterm-screen.textContent.
    // The canvas renderer's accessibility layer only shows the current cursor
    // row; once the shell returns to the prompt, output rows disappear.
    await waitForTerminalOutput(page, markerA);

    // Type marker in session B
    await page.goto(`/?s=${encodeURIComponent(nameB)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await waitForPrompt();
    await page.keyboard.type(`echo ${markerB}`);
    await page.keyboard.press("Enter");
    await waitForTerminalOutput(page, markerB);

    // Session B should NOT contain marker A
    const textB = await readTerminalBuffer(page);
    expect(textB).not.toContain(markerA);

    // Go back to session A — buffer replay should show marker A but not B
    await page.goto(`/?s=${encodeURIComponent(nameA)}`);
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });
    await waitForTerminalOutput(page, markerA);
    const textA = await readTerminalBuffer(page);
    expect(textA).not.toContain(markerB);

    // Cleanup
    await deleteSession(page, nameA);
    await deleteSession(page, nameB);
  });
});
