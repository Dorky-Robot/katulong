import { test, expect } from "@playwright/test";
import { waitForShellReady, waitForAppReady } from "./helpers.js";

test.describe("Sidebar", () => {
  // Helper: delete a session via API (best-effort cleanup)
  async function deleteSession(page, name) {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      name,
    );
  }

  test.describe("Layout", () => {
    test("sidebar and main stage are side by side", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      // App layout should be a flex container
      const layout = page.locator("#app-layout");
      await expect(layout).toBeVisible();

      // Sidebar should exist
      const sidebar = page.locator("#sidebar");
      await expect(sidebar).toBeVisible();

      // Main stage with shortcut bar and terminal
      const mainStage = page.locator("#main-stage");
      await expect(mainStage).toBeVisible();

      // Shortcut bar should be inside main-stage (not fixed/global)
      const bar = page.locator("#main-stage #shortcut-bar");
      await expect(bar).toBeVisible();

      // Terminal should be inside main-stage
      const terminal = page.locator("#main-stage #terminal-container");
      await expect(terminal).toBeVisible();
    });

    test("shortcut bar is not position fixed", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const position = await page.locator("#shortcut-bar").evaluate(
        (el) => getComputedStyle(el).position
      );
      expect(position).not.toBe("fixed");
    });

    test("sidebar toolbar and shortcut bar are at the same vertical level", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const sidebarToolbarTop = await page.locator("#sidebar-toolbar").evaluate(
        (el) => el.getBoundingClientRect().top
      );
      const shortcutBarTop = await page.locator("#shortcut-bar").evaluate(
        (el) => el.getBoundingClientRect().top
      );
      // Both should start at the same Y position (within 2px tolerance)
      expect(Math.abs(sidebarToolbarTop - shortcutBarTop)).toBeLessThan(2);
    });

    test("terminal fills available space below shortcut bar", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const termRect = await page.locator("#terminal-container").evaluate(
        (el) => {
          const rect = el.getBoundingClientRect();
          return { top: rect.top, height: rect.height };
        }
      );
      // Terminal should have meaningful height
      expect(termRect.height).toBeGreaterThan(100);
      // Terminal top should be below the shortcut bar
      const barBottom = await page.locator("#shortcut-bar").evaluate(
        (el) => el.getBoundingClientRect().bottom
      );
      expect(termRect.top).toBeGreaterThanOrEqual(barBottom - 1);
    });
  });

  test.describe("Toggle", () => {
    test("starts collapsed by default", async ({ page }) => {
      // Clear any saved state
      await page.goto("/");
      await page.evaluate(() => localStorage.removeItem("sidebar-collapsed"));
      await page.reload();
      await waitForAppReady(page);

      const sidebar = page.locator("#sidebar");
      await expect(sidebar).toHaveClass(/collapsed/);
    });

    test("chevron toggle expands and collapses", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const sidebar = page.locator("#sidebar");
      const toggle = page.locator("#sidebar-toggle");

      // Ensure collapsed first
      await page.evaluate(() => localStorage.setItem("sidebar-collapsed", "1"));
      await page.reload();
      await waitForAppReady(page);
      await expect(sidebar).toHaveClass(/collapsed/);

      // Click > to expand
      await toggle.click();
      await expect(sidebar).not.toHaveClass(/collapsed/);

      // Chevron should now point left
      await expect(toggle.locator("i")).toHaveClass(/ph-caret-left/);

      // Click < to collapse
      await toggle.click();
      await expect(sidebar).toHaveClass(/collapsed/);

      // Chevron should now point right
      await expect(toggle.locator("i")).toHaveClass(/ph-caret-right/);
    });

    test("session button in shortcut bar toggles sidebar", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const sidebar = page.locator("#sidebar");

      // Ensure collapsed
      await page.evaluate(() => localStorage.setItem("sidebar-collapsed", "1"));
      await page.reload();
      await waitForAppReady(page);
      await expect(sidebar).toHaveClass(/collapsed/);

      // Click session button to expand
      await page.locator("#shortcut-bar .session-btn").click();
      await expect(sidebar).not.toHaveClass(/collapsed/);

      // Click session button again to collapse
      await page.locator("#shortcut-bar .session-btn").click();
      await expect(sidebar).toHaveClass(/collapsed/);
    });

    test("collapsed state persists across reloads", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      // Expand sidebar
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Reload
      await page.reload();
      await waitForAppReady(page);

      // Should still be expanded
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Collapse it
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);

      // Reload again
      await page.reload();
      await waitForAppReady(page);

      // Should still be collapsed
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);
    });
  });

  test.describe("Session cards", () => {
    test("shows current session card when sidebar is expanded", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      // Expand sidebar
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Should show at least the default session card
      const cards = page.locator(".session-card");
      await expect(cards.first()).toBeVisible({ timeout: 10000 });

      // Current session card should have active class
      const activeCard = page.locator(".session-card.active");
      await expect(activeCard).toBeVisible();
    });

    test("session cards show terminal preview text", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      // Type something in the terminal to generate buffer content
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("echo SIDEBAR_PREVIEW_TEST");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.querySelector(".xterm-screen")?.textContent?.includes("SIDEBAR_PREVIEW_TEST"),
        { timeout: 5000 }
      );

      // Expand sidebar — should fetch fresh data including previews
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Wait for card with preview content
      const preview = page.locator(".session-card.active .session-card-preview");
      await expect(preview).toBeVisible({ timeout: 5000 });

      // Preview should contain some text (buffer content)
      const text = await preview.textContent();
      expect(text.length).toBeGreaterThan(0);
    });

    test("session card shows session name", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      // Expand sidebar
      await page.locator("#sidebar-toggle").click();

      // Default session card should show name
      const name = page.locator(".session-card.active .session-card-name");
      await expect(name).toBeVisible({ timeout: 10000 });
      await expect(name).toHaveValue("default");
    });

    test("multiple session cards appear for multiple sessions", async ({ page }) => {
      const sessionName = `sidebar-multi-${Date.now()}`;

      // Count existing sessions first
      await page.goto("/");
      await waitForAppReady(page);
      const existingCount = await page.evaluate(() =>
        fetch("/sessions").then(r => r.json()).then(s => s.length)
      );

      // Create an extra session
      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      // Go back to default
      await page.goto("/");
      await waitForAppReady(page);

      // Expand sidebar
      await page.locator("#sidebar-toggle").click();

      // Should have more cards than before
      const cards = page.locator(".session-card");
      const newCount = await cards.count();
      expect(newCount).toBeGreaterThan(existingCount);

      // Should have at least one active card (current session)
      const activeCards = page.locator(".session-card.active");
      await expect(activeCards).toHaveCount(1);

      // Should have a card for the new session
      const newCard = page.locator(".session-card", {
        has: page.getByLabel(`Session name: ${sessionName}`),
      });
      await expect(newCard).toBeVisible();

      // Cleanup
      await deleteSession(page, sessionName);
    });
  });

  test.describe("New session", () => {
    test("+ button creates new session and switches to it", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      // Expand sidebar first
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Click + button
      await page.locator("#sidebar-add-btn").click();

      // URL should change to the new session (auto-named)
      await page.waitForFunction(
        () => window.location.search.includes("s=session-"),
        { timeout: 5000 }
      );

      // The new session should be the active card
      const activeCard = page.locator(".session-card.active");
      await expect(activeCard).toBeVisible();

      // Sidebar should still be open
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Cleanup — delete the new session
      const newName = new URL(page.url()).searchParams.get("s");
      if (newName) await deleteSession(page, newName);
    });

    test("+ button expands sidebar if it was collapsed", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      // Ensure collapsed
      await page.evaluate(() => localStorage.setItem("sidebar-collapsed", "1"));
      await page.reload();
      await waitForAppReady(page);
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);

      // Click + button
      await page.locator("#sidebar-add-btn").click();

      // Should expand and create a new session
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/, { timeout: 5000 });

      // Cleanup
      const newName = new URL(page.url()).searchParams.get("s");
      if (newName && newName !== "default") await deleteSession(page, newName);
    });
  });

  test.describe("Session switching", () => {
    test("sidebar stays open when switching sessions via card click", async ({ page }) => {
      const sessionName = `sidebar-switch-${Date.now()}`;

      // Create a second session
      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      // Go to default session
      await page.goto("/");
      await waitForAppReady(page);

      // Expand sidebar
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Click on the other session card to switch (should NOT do full page reload)
      const card = page.locator(".session-card", {
        has: page.getByLabel(`Session name: ${sessionName}`),
      });
      await expect(card).toBeVisible({ timeout: 10000 });
      await card.click();

      // URL should update without full page navigation
      await page.waitForURL(`**/?s=${encodeURIComponent(sessionName)}`);

      // Sidebar should STILL be open immediately (no FOUC)
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Shortcut bar should show the new session name
      await expect(page.locator("#shortcut-bar .session-btn")).toContainText(sessionName);

      // Terminal should reconnect and show content
      await page.waitForSelector(".xterm-screen", { timeout: 5000 });

      // The new session should now be the active card
      const activeCard = page.locator(".session-card.active");
      await expect(activeCard).toBeVisible({ timeout: 10000 });
      await expect(activeCard.locator(".session-card-name")).toHaveValue(sessionName);

      // Cleanup
      await deleteSession(page, sessionName);
    });

    test("sidebar stays closed when it was closed before switching sessions", async ({ page }) => {
      const sessionName = `sidebar-closed-switch-${Date.now()}`;

      // Create a second session
      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      // Go to default session, ensure sidebar collapsed
      await page.goto("/");
      await waitForAppReady(page);
      await page.evaluate(() => localStorage.setItem("sidebar-collapsed", "1"));
      await page.reload();
      await waitForAppReady(page);
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);

      // Navigate directly to the other session
      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      // Sidebar should still be collapsed
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);

      // Cleanup
      await deleteSession(page, sessionName);
    });
  });

  test.describe("Terminal interaction", () => {
    test("terminal remains functional when sidebar is toggled", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const marker = `TERM_SIDEBAR_${Date.now()}`;

      // Type while sidebar is collapsed
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(`echo ${marker}`);
      await page.keyboard.press("Enter");

      await page.waitForFunction(
        (m) => document.querySelector(".xterm-screen")?.textContent?.includes(m),
        marker,
        { timeout: 5000 }
      );

      // Expand sidebar
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Terminal should still show the marker
      await expect(page.locator(".xterm-rows")).toContainText(marker);

      // Type another command with sidebar open
      const marker2 = `OPEN_${Date.now()}`;
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(`echo ${marker2}`);
      await page.keyboard.press("Enter");

      await page.waitForFunction(
        (m) => document.querySelector(".xterm-screen")?.textContent?.includes(m),
        marker2,
        { timeout: 5000 }
      );

      // Collapse sidebar
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);

      // Both markers should still be visible
      await expect(page.locator(".xterm-rows")).toContainText(marker);
      await expect(page.locator(".xterm-rows")).toContainText(marker2);
    });

    test("terminal resizes when sidebar toggles", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      // Get terminal width with sidebar collapsed
      const collapsedWidth = await page.locator("#terminal-container").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      // Expand sidebar
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      // Wait for transition + resize
      await page.waitForTimeout(300);

      // Terminal should be narrower
      const expandedWidth = await page.locator("#terminal-container").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      expect(expandedWidth).toBeLessThan(collapsedWidth);
    });
  });
});
