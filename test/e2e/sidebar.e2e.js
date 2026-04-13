import { test, expect } from "@playwright/test";
import { waitForShellReady, waitForAppReady } from "./helpers.js";

test.describe("Sidebar & Tab Bar", () => {
  // Helper: delete a session via API (best-effort cleanup)
  async function deleteSession(page, name) {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      name,
    );
  }

  // Helper: check if current viewport uses overlay sidebar (mobile only — tablet gets desktop tabs)
  function isOverlayViewport(testInfo) {
    return testInfo.project.name === "mobile";
  }

  // Helper: open sidebar on mobile/tablet
  async function openSidebar(page) {
    await page.locator("#shortcut-bar .session-btn").click();
    await expect(page.locator("#sidebar")).toHaveClass(/mobile-open/);
  }

  test.describe("Layout", () => {
    test("main stage with shortcut bar and terminal exists", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      await expect(page.locator("#app-layout")).toBeVisible();
      await expect(page.locator("#main-stage")).toBeVisible();
      await expect(page.locator("#main-stage #shortcut-bar")).toBeVisible();
      await expect(page.locator("#main-stage #terminal-container")).toBeVisible();
    });

    test("shortcut bar is not position fixed", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const position = await page.locator("#shortcut-bar").evaluate(
        (el) => getComputedStyle(el).position
      );
      expect(position).not.toBe("fixed");
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
      expect(termRect.height).toBeGreaterThan(100);
      const barBottom = await page.locator("#shortcut-bar").evaluate(
        (el) => el.getBoundingClientRect().bottom
      );
      expect(termRect.top).toBeGreaterThanOrEqual(barBottom - 1);
    });
  });

  test.describe("Desktop tab bar", () => {
    test.beforeEach(async ({}, testInfo) => {
      if (isOverlayViewport(testInfo)) test.skip();
    });

    test("sidebar is hidden on desktop", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const display = await page.locator("#sidebar").evaluate(
        (el) => getComputedStyle(el).display
      );
      expect(display).toBe("none");
    });

    test("tab bar shows session tabs on desktop", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const tabs = page.locator("#shortcut-bar .tab-bar-tab");
      await expect(tabs.first()).toBeVisible({ timeout: 10000 });

      // Active tab should exist for current session
      const activeTab = page.locator("#shortcut-bar .tab-bar-tab.active");
      await expect(activeTab).toHaveCount(1);
    });

    test("tab bar shows new session + button", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const addBtn = page.locator("#shortcut-bar .tab-bar-add");
      await expect(addBtn).toBeVisible();
    });

    test("floating island shows utility buttons (terminal, files, browser, settings)", async ({ page }, testInfo) => {
      await page.goto("/");
      await waitForAppReady(page);

      // Desktop: 4 utility buttons (terminal, files, browser, settings)
      // Tablet: adds Esc, Tab, keyboard, dictation = 8 total
      const expected = testInfo.project.name === "tablet" ? 8 : 4;
      await expect(page.locator("#key-island .key-island-btn")).toHaveCount(expected);
    });

    test("clicking + button opens dropdown with New session", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      await page.locator("#shortcut-bar .tab-bar-add").click();

      // Dropdown menu should appear with "New session" option
      const menu = page.locator(".tab-context-menu");
      await expect(menu).toBeVisible();
      const newItem = menu.locator(".tab-menu-item", { hasText: "New session" });
      await expect(newItem).toBeVisible();
      await newItem.click();

      await page.waitForFunction(
        () => window.location.search.includes("s=session-"),
        { timeout: 5000 }
      );

      const newName = new URL(page.url()).searchParams.get("s");
      if (newName) await deleteSession(page, newName);
    });

    test("clicking a tab switches session", async ({ page }) => {
      const sessionName = `tab-switch-${Date.now()}`;

      // Create a second session
      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      // Go to default session
      await page.goto("/?s=default");
      await waitForAppReady(page);

      // Wait for our test session tab to appear
      const targetTab = page.locator(`#shortcut-bar .tab-bar-tab[data-session="${sessionName}"]`);
      await expect(targetTab).toBeVisible({ timeout: 10000 });

      // Click the test session tab
      await targetTab.click();

      await page.waitForURL(`**/?s=${encodeURIComponent(sessionName)}`, { timeout: 5000 });

      await deleteSession(page, sessionName);
    });

    test("no Esc/Tab/keyboard buttons on desktop (touch-only)", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      await expect(page.locator("#shortcut-bar .shortcut-btn")).toHaveCount(0);
      await expect(page.locator("#shortcut-bar .bar-icon-btn")).toHaveCount(0);
    });

    test("tab close button visible on hover", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const tab = page.locator("#shortcut-bar .tab-bar-tab").first();
      await expect(tab).toBeVisible({ timeout: 10000 });
      await tab.hover();

      const closeBtn = tab.locator(".tab-close");
      await expect(closeBtn).toBeVisible();
    });

    test("terminal gets full width on desktop (no sidebar)", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const viewportWidth = page.viewportSize().width;
      const mainStageWidth = await page.locator("#main-stage").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      expect(mainStageWidth).toBeGreaterThan(viewportWidth - 10);
    });
  });

  test.describe("Mobile sidebar", () => {
    test.beforeEach(async ({}, testInfo) => {
      if (!isOverlayViewport(testInfo)) test.skip();
    });

    test("sidebar opens as overlay without pushing content", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const widthBefore = await page.locator("#terminal-container").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      await openSidebar(page);

      const sidebar = page.locator("#sidebar");
      await expect(sidebar).toBeVisible();

      const position = await sidebar.evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe("fixed");

      const widthAfter = await page.locator("#terminal-container").evaluate(
        (el) => el.getBoundingClientRect().width
      );
      expect(Math.abs(widthAfter - widthBefore)).toBeLessThan(5);
    });

    test("backdrop tap closes sidebar", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page);

      const backdrop = page.locator("#sidebar-backdrop");
      await expect(backdrop).toHaveClass(/visible/);

      await backdrop.click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/mobile-open/);
    });

    test("switching sessions closes sidebar", async ({ page }) => {
      const sessionName = `responsive-switch-${Date.now()}`;

      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page);

      const card = page.locator(".session-card", {
        has: page.getByLabel(`Session name: ${sessionName}`),
      });
      await expect(card).toBeVisible({ timeout: 10000 });
      await card.click();

      await expect(page.locator("#sidebar")).not.toHaveClass(/mobile-open/);
      await page.waitForURL(`**/?s=${encodeURIComponent(sessionName)}`);

      await deleteSession(page, sessionName);
    });

    test("sidebar does not consume space when closed", async ({ page }, testInfo) => {
      if (testInfo.project.name !== "tablet") { test.skip(); return; }

      await page.goto("/");
      await waitForAppReady(page);

      const viewportWidth = page.viewportSize().width;
      const mainStageWidth = await page.locator("#main-stage").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      expect(mainStageWidth).toBeGreaterThan(viewportWidth - 10);
    });

    test("shortcut bar shows Esc/Tab on tablet, utility buttons on phone", async ({ page }, testInfo) => {
      await page.goto("/");
      await waitForAppReady(page);

      if (isOverlayViewport(testInfo)) {
        // Phone: utility icons in toolbar, no Esc/Tab (those are in the key island)
        const iconBtns = page.locator("#shortcut-bar .bar-icon-btn");
        await expect(iconBtns).not.toHaveCount(0);
      } else {
        // Tablet: Esc/Tab in toolbar
        const shortcutBtns = page.locator("#shortcut-bar .shortcut-btn");
        await expect(shortcutBtns).toHaveCount(2);
      }
    });

    test("new session button visible in shortcut bar on mobile", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const btn = page.locator("#shortcut-bar .bar-new-session-btn");
      await expect(btn).toBeVisible();
    });
  });

  test.describe("Session cards (mobile)", () => {
    test.beforeEach(async ({}, testInfo) => {
      if (!isOverlayViewport(testInfo)) test.skip();
    });

    test("shows current session card when sidebar is open", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page);

      const cards = page.locator(".session-card");
      await expect(cards.first()).toBeVisible({ timeout: 10000 });
      const activeCard = page.locator(".session-card.active");
      await expect(activeCard).toBeVisible();
    });

    test("session cards show terminal preview text", async ({ page }) => {
      const marker = `PREVIEW_MARKER_${Date.now()}`;

      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page);

      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(`echo ${marker}`);
      await page.keyboard.press("Enter");

      await page.waitForFunction(
        (m) => document.querySelector(".xterm-screen")?.textContent?.includes(m),
        marker,
        { timeout: 5000 }
      );

      const preview = page.locator(".session-card.active .session-card-preview");
      await expect(preview).toContainText(marker, { timeout: 10000 });
    });

    test("session card shows session name", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page);

      const name = page.locator(".session-card.active .session-card-name");
      await expect(name).toBeVisible({ timeout: 10000 });
      await expect(name).toHaveValue("default");
    });
  });

  test.describe("Terminal interaction", () => {
    test("terminal remains functional after interacting with bar", async ({ page }, testInfo) => {
      await page.goto("/");
      await waitForAppReady(page);

      const marker = `TERM_BAR_${Date.now()}`;

      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(`echo ${marker}`);
      await page.keyboard.press("Enter");

      await page.waitForFunction(
        (m) => document.querySelector(".xterm-screen")?.textContent?.includes(m),
        marker,
        { timeout: 5000 }
      );

      // On mobile, open/close sidebar; on desktop, just verify terminal still works
      if (isOverlayViewport(testInfo)) {
        await openSidebar(page);
        await page.locator("#sidebar-backdrop").click();
        await expect(page.locator("#sidebar")).not.toHaveClass(/mobile-open/);
      }

      await expect(page.locator(".xterm-rows")).toContainText(marker);

      const marker2 = `AFTER_${Date.now()}`;
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(`echo ${marker2}`);
      await page.keyboard.press("Enter");

      await page.waitForFunction(
        (m) => document.querySelector(".xterm-screen")?.textContent?.includes(m),
        marker2,
        { timeout: 5000 }
      );
    });
  });
});
