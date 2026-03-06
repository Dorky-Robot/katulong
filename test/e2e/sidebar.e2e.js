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

  // Helper: check if current viewport uses overlay sidebar (mobile/tablet)
  function isOverlayViewport(testInfo) {
    return testInfo.project.name === "mobile" || testInfo.project.name === "tablet";
  }

  // Helper: open sidebar in a viewport-appropriate way
  async function openSidebar(page, testInfo) {
    if (isOverlayViewport(testInfo)) {
      await page.locator("#shortcut-bar .session-btn").click();
      await expect(page.locator("#sidebar")).toHaveClass(/mobile-open/);
    } else {
      const sidebar = page.locator("#sidebar");
      if (await sidebar.evaluate((el) => el.classList.contains("collapsed"))) {
        await page.locator("#sidebar-toggle").click();
        await expect(sidebar).not.toHaveClass(/collapsed/);
      }
    }
  }

  // Helper: close sidebar in a viewport-appropriate way
  async function closeSidebar(page, testInfo) {
    if (isOverlayViewport(testInfo)) {
      await page.locator("#sidebar-backdrop").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/mobile-open/);
    } else {
      const sidebar = page.locator("#sidebar");
      if (!await sidebar.evaluate((el) => el.classList.contains("collapsed"))) {
        await page.locator("#sidebar-toggle").click();
        await expect(sidebar).toHaveClass(/collapsed/);
      }
    }
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

    test("on desktop, sidebar toolbar and shortcut bar are at the same vertical level", async ({ page }, testInfo) => {
      if (isOverlayViewport(testInfo)) { test.skip(); return; }

      await page.goto("/");
      await waitForAppReady(page);

      const sidebarToolbarTop = await page.locator("#sidebar-toolbar").evaluate(
        (el) => el.getBoundingClientRect().top
      );
      const shortcutBarTop = await page.locator("#shortcut-bar").evaluate(
        (el) => el.getBoundingClientRect().top
      );
      expect(Math.abs(sidebarToolbarTop - shortcutBarTop)).toBeLessThan(2);
    });
  });

  test.describe("Toggle (desktop)", () => {
    test.beforeEach(async ({}, testInfo) => {
      if (isOverlayViewport(testInfo)) test.skip();
    });

    test("starts collapsed by default", async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => localStorage.removeItem("sidebar-collapsed"));
      await page.reload();
      await waitForAppReady(page);

      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);
    });

    test("chevron toggle expands and collapses", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const sidebar = page.locator("#sidebar");
      const toggle = page.locator("#sidebar-toggle");

      await page.evaluate(() => localStorage.setItem("sidebar-collapsed", "1"));
      await page.reload();
      await waitForAppReady(page);
      await expect(sidebar).toHaveClass(/collapsed/);

      await toggle.click();
      await expect(sidebar).not.toHaveClass(/collapsed/);
      await expect(toggle.locator("i")).toHaveClass(/ph-caret-left/);

      await toggle.click();
      await expect(sidebar).toHaveClass(/collapsed/);
      await expect(toggle.locator("i")).toHaveClass(/ph-caret-right/);
    });

    test("session button in shortcut bar toggles sidebar", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      const sidebar = page.locator("#sidebar");

      await page.evaluate(() => localStorage.setItem("sidebar-collapsed", "1"));
      await page.reload();
      await waitForAppReady(page);
      await expect(sidebar).toHaveClass(/collapsed/);

      await page.locator("#shortcut-bar .session-btn").click();
      await expect(sidebar).not.toHaveClass(/collapsed/);

      await page.locator("#shortcut-bar .session-btn").click();
      await expect(sidebar).toHaveClass(/collapsed/);
    });

    test("collapsed state persists across reloads", async ({ page }) => {
      await page.goto("/");
      await waitForAppReady(page);

      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      await page.reload();
      await waitForAppReady(page);
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);

      await page.reload();
      await waitForAppReady(page);
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);
    });
  });

  test.describe("Session cards", () => {
    test("shows current session card when sidebar is expanded", async ({ page }, testInfo) => {
      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page, testInfo);

      const cards = page.locator(".session-card");
      await expect(cards.first()).toBeVisible({ timeout: 10000 });
      const activeCard = page.locator(".session-card.active");
      await expect(activeCard).toBeVisible();
    });

    test("session cards show terminal preview text", async ({ page }, testInfo) => {
      const marker = `PREVIEW_MARKER_${Date.now()}`;

      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page, testInfo);

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

    test("session card shows session name", async ({ page }, testInfo) => {
      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page, testInfo);

      const name = page.locator(".session-card.active .session-card-name");
      await expect(name).toBeVisible({ timeout: 10000 });
      await expect(name).toHaveValue("default");
    });

    test("multiple session cards appear for multiple sessions", async ({ page }, testInfo) => {
      const sessionName = `sidebar-multi-${Date.now()}`;

      await page.goto("/");
      await waitForAppReady(page);
      const existingCount = await page.evaluate(() =>
        fetch("/sessions").then(r => r.json()).then(s => s.length)
      );

      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page, testInfo);

      const cards = page.locator(".session-card");
      const newCount = await cards.count();
      expect(newCount).toBeGreaterThan(existingCount);

      const activeCards = page.locator(".session-card.active");
      await expect(activeCards).toHaveCount(1);

      const newCard = page.locator(".session-card", {
        has: page.getByLabel(`Session name: ${sessionName}`),
      });
      await expect(newCard).toBeVisible();

      await deleteSession(page, sessionName);
    });
  });

  test.describe("New session", () => {
    test("+ button creates new session and switches to it", async ({ page }, testInfo) => {
      await page.goto("/");
      await waitForAppReady(page);

      // On mobile/tablet, use the shortcut bar + button; on desktop, use sidebar +
      if (isOverlayViewport(testInfo)) {
        await page.locator("#shortcut-bar .bar-new-session-btn").click();
      } else {
        await openSidebar(page, testInfo);
        await page.locator("#sidebar-add-btn").click();
      }

      await page.waitForFunction(
        () => window.location.search.includes("s=session-"),
        { timeout: 5000 }
      );

      const activeCard = page.locator(".session-card.active");
      await expect(activeCard).toBeVisible();

      const newName = new URL(page.url()).searchParams.get("s");
      if (newName) await deleteSession(page, newName);
    });

    test("on desktop, + button expands sidebar if it was collapsed", async ({ page }, testInfo) => {
      if (isOverlayViewport(testInfo)) { test.skip(); return; }

      await page.goto("/");
      await waitForAppReady(page);

      await page.evaluate(() => localStorage.setItem("sidebar-collapsed", "1"));
      await page.reload();
      await waitForAppReady(page);
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);

      await page.locator("#sidebar-add-btn").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/, { timeout: 5000 });

      const newName = new URL(page.url()).searchParams.get("s");
      if (newName && newName !== "default") await deleteSession(page, newName);
    });
  });

  test.describe("Session switching", () => {
    test("sidebar stays open when switching sessions via card click (desktop)", async ({ page }, testInfo) => {
      if (isOverlayViewport(testInfo)) { test.skip(); return; }

      const sessionName = `sidebar-switch-${Date.now()}`;

      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      await page.goto("/");
      await waitForAppReady(page);

      await openSidebar(page, testInfo);

      const card = page.locator(".session-card", {
        has: page.getByLabel(`Session name: ${sessionName}`),
      });
      await expect(card).toBeVisible({ timeout: 10000 });
      await card.click();

      await page.waitForURL(`**/?s=${encodeURIComponent(sessionName)}`);
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);
      await expect(page.locator("#shortcut-bar .session-btn")).toContainText(sessionName);

      await page.waitForSelector(".xterm-screen", { timeout: 5000 });

      const activeCard = page.locator(".session-card.active");
      await expect(activeCard).toBeVisible({ timeout: 10000 });
      await expect(activeCard.locator(".session-card-name")).toHaveValue(sessionName);

      await deleteSession(page, sessionName);
    });

    test("sidebar stays closed when it was closed before switching sessions", async ({ page }, testInfo) => {
      if (isOverlayViewport(testInfo)) { test.skip(); return; }
      const sessionName = `sidebar-closed-switch-${Date.now()}`;

      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      await page.goto("/");
      await waitForAppReady(page);
      await page.evaluate(() => localStorage.setItem("sidebar-collapsed", "1"));
      await page.reload();
      await waitForAppReady(page);
      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);

      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      await expect(page.locator("#sidebar")).toHaveClass(/collapsed/);

      await deleteSession(page, sessionName);
    });
  });

  test.describe("Responsive", () => {
    test("on mobile/tablet, sidebar opens as overlay without pushing content", async ({ page }, testInfo) => {
      if (!isOverlayViewport(testInfo)) { test.skip(); return; }

      await page.goto("/");
      await waitForAppReady(page);

      const widthBefore = await page.locator("#terminal-container").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      await page.locator("#shortcut-bar .session-btn").click();

      const sidebar = page.locator("#sidebar");
      await expect(sidebar).toBeVisible();

      const position = await sidebar.evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe("fixed");

      const widthAfter = await page.locator("#terminal-container").evaluate(
        (el) => el.getBoundingClientRect().width
      );
      expect(Math.abs(widthAfter - widthBefore)).toBeLessThan(5);
    });

    test("on mobile/tablet, backdrop tap closes sidebar", async ({ page }, testInfo) => {
      if (!isOverlayViewport(testInfo)) { test.skip(); return; }

      await page.goto("/");
      await waitForAppReady(page);

      await page.locator("#shortcut-bar .session-btn").click();
      await expect(page.locator("#sidebar")).toHaveClass(/mobile-open/);

      const backdrop = page.locator("#sidebar-backdrop");
      await expect(backdrop).toHaveClass(/visible/);

      await backdrop.click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/mobile-open/);
    });

    test("on mobile/tablet, switching sessions closes sidebar", async ({ page }, testInfo) => {
      if (!isOverlayViewport(testInfo)) { test.skip(); return; }

      const sessionName = `responsive-switch-${Date.now()}`;

      await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
      await waitForAppReady(page);

      await page.goto("/");
      await waitForAppReady(page);

      await page.locator("#shortcut-bar .session-btn").click();
      await expect(page.locator("#sidebar")).toHaveClass(/mobile-open/);

      const card = page.locator(".session-card", {
        has: page.getByLabel(`Session name: ${sessionName}`),
      });
      await expect(card).toBeVisible({ timeout: 10000 });
      await card.click();

      await expect(page.locator("#sidebar")).not.toHaveClass(/mobile-open/);
      await page.waitForURL(`**/?s=${encodeURIComponent(sessionName)}`);

      await deleteSession(page, sessionName);
    });

    test("on tablet, sidebar does not consume space when closed", async ({ page }, testInfo) => {
      if (testInfo.project.name !== "tablet") { test.skip(); return; }

      await page.goto("/");
      await waitForAppReady(page);

      const viewportWidth = page.viewportSize().width;
      const mainStageWidth = await page.locator("#main-stage").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      expect(mainStageWidth).toBeGreaterThan(viewportWidth - 10);
    });

    test("on desktop, sidebar is inline and takes space", async ({ page }, testInfo) => {
      if (isOverlayViewport(testInfo)) { test.skip(); return; }

      await page.goto("/");
      await waitForAppReady(page);

      const position = await page.locator("#sidebar").evaluate(
        (el) => getComputedStyle(el).position
      );
      expect(position).not.toBe("fixed");

      const sidebarWidth = await page.locator("#sidebar").evaluate(
        (el) => el.getBoundingClientRect().width
      );
      expect(sidebarWidth).toBeCloseTo(56, -1);
    });

    test("on mobile/tablet, new session button visible in shortcut bar", async ({ page }, testInfo) => {
      if (!isOverlayViewport(testInfo)) { test.skip(); return; }

      await page.goto("/");
      await waitForAppReady(page);

      const btn = page.locator("#shortcut-bar .bar-new-session-btn");
      await expect(btn).toBeVisible();
    });
  });

  test.describe("Terminal interaction", () => {
    test("terminal remains functional when sidebar is toggled", async ({ page }, testInfo) => {
      await page.goto("/");
      await waitForAppReady(page);

      const marker = `TERM_SIDEBAR_${Date.now()}`;

      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(`echo ${marker}`);
      await page.keyboard.press("Enter");

      await page.waitForFunction(
        (m) => document.querySelector(".xterm-screen")?.textContent?.includes(m),
        marker,
        { timeout: 5000 }
      );

      await openSidebar(page, testInfo);

      await expect(page.locator(".xterm-rows")).toContainText(marker);

      const marker2 = `OPEN_${Date.now()}`;
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(`echo ${marker2}`);
      await page.keyboard.press("Enter");

      await page.waitForFunction(
        (m) => document.querySelector(".xterm-screen")?.textContent?.includes(m),
        marker2,
        { timeout: 5000 }
      );

      await closeSidebar(page, testInfo);

      await expect(page.locator(".xterm-rows")).toContainText(marker);
      await expect(page.locator(".xterm-rows")).toContainText(marker2);
    });

    test("on desktop, terminal resizes when sidebar toggles", async ({ page }, testInfo) => {
      if (isOverlayViewport(testInfo)) { test.skip(); return; }

      await page.goto("/");
      await waitForAppReady(page);

      const collapsedWidth = await page.locator("#terminal-container").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).not.toHaveClass(/collapsed/);

      await page.waitForTimeout(300);

      const expandedWidth = await page.locator("#terminal-container").evaluate(
        (el) => el.getBoundingClientRect().width
      );

      expect(expandedWidth).toBeLessThan(collapsedWidth);
    });
  });
});
