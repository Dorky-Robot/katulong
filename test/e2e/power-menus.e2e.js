import { test, expect } from "@playwright/test";
import { cleanupSession } from "./helpers.js";

// Light app-ready wait — does NOT block on shell prompt. Power-menu tests
// don't need the shell to be running, just the app's keyboard listeners
// installed (which happens once the SPA mounts).
async function waitForUiReady(page) {
  await page.waitForSelector(".xterm", { timeout: 15000 });
  await page.waitForSelector(".xterm-screen", { timeout: 5000 });
  // Wait for the command-mode attribute to be initialized — proof that
  // command-mode.js has run.
  await page.waitForFunction(
    () => document.documentElement.dataset.commandMode === "false",
    { timeout: 5000 }
  );
}

async function setupLight({ page, context, testInfo, prefix = "menu" }) {
  const sessionName = `${prefix}-${testInfo.testId}-${Date.now()}`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
  await waitForUiReady(page);
  return sessionName;
}

/**
 * Power menus — the two top-level keyboard surfaces:
 *
 *   Cmd+/  → fuzzy picker (VS Code Command Palette style)
 *   Cmd+;  → vim-style chord menu (verbs on focused tile + new tile)
 *
 * Both must toggle (open if closed; close if already open). The chord menu
 * must walk the tree in response to keystrokes after entry.
 *
 * Cmd+T / Cmd+1..9 / etc. are PWA-only Cmd+ aliases — exercised by
 * overriding matchMedia so the page reports standalone display-mode.
 */

test.describe("Power menus — Cmd+; chord menu", () => {
  test.describe.configure({ mode: "serial" });

  let sessionName;

  test.beforeEach(async ({ page, context }, testInfo) => {
    sessionName = await setupLight({ page, context, testInfo });
  });

  test.afterEach(async ({ page }) => {
    await cleanupSession(page, sessionName);
  });

  test("Cmd+; opens command mode and Cmd+; again closes it", async ({ page }) => {
    await page.keyboard.press("Meta+;");
    await expect(page.locator("html")).toHaveAttribute("data-command-mode", "true");

    await page.keyboard.press("Meta+;");
    await expect(page.locator("html")).toHaveAttribute("data-command-mode", "false");
  });

  test("Ctrl+; also toggles command mode (cross-platform fallback)", async ({ page }) => {
    await page.keyboard.press("Control+;");
    await expect(page.locator("html")).toHaveAttribute("data-command-mode", "true");

    await page.keyboard.press("Control+;");
    await expect(page.locator("html")).toHaveAttribute("data-command-mode", "false");
  });

  test("Esc exits command mode from any depth", async ({ page }) => {
    await page.keyboard.press("Meta+;");
    await page.keyboard.press("t");
    // Surface shows the tile branch — breadcrumb says "Command › tile"
    await expect(page.locator(".command-surface-crumb")).toContainText("tile");

    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-command-mode", "false");
  });

  test("Backspace at the tile branch returns to root, not exit", async ({ page }) => {
    await page.keyboard.press("Meta+;");
    await page.keyboard.press("t");
    await expect(page.locator(".command-surface-crumb")).toContainText("tile");

    await page.keyboard.press("Backspace");
    // Back at root
    await expect(page.locator(".command-surface-crumb")).toHaveText("Command");
    // Still active
    await expect(page.locator("html")).toHaveAttribute("data-command-mode", "true");
  });

  test("t branch surfaces all expected verbs", async ({ page }) => {
    await page.keyboard.press("Meta+;");
    await page.keyboard.press("t");

    const pillTexts = await page.locator(".command-surface-pill").allTextContents();
    const joined = pillTexts.join(" ");
    for (const verb of ["detach", "rename", "kill", "clear", "search"]) {
      expect(joined).toContain(verb);
    }
  });

  test("n branch surfaces all expected new-tile types", async ({ page }) => {
    await page.keyboard.press("Meta+;");
    await page.keyboard.press("n");

    const pillTexts = await page.locator(".command-surface-pill").allTextContents();
    const joined = pillTexts.join(" ");
    for (const type of ["terminal", "files", "browser", "feed", "sipag"]) {
      expect(joined).toContain(type);
    }
  });

  test("t x exits command mode (detach action dispatched)", async ({ page }) => {
    await page.keyboard.press("Meta+;");
    await page.keyboard.press("t");
    await page.keyboard.press("x");

    // Mode exits as soon as a leaf action fires.
    await expect(page.locator("html")).toHaveAttribute("data-command-mode", "false");
  });

  test("n t creates a new terminal tile", async ({ page }) => {
    const initialCount = await page.locator(".carousel-card").count();

    await page.keyboard.press("Meta+;");
    await page.keyboard.press("n");
    await page.keyboard.press("t");

    // Mode exits; new tile is added.
    await expect(page.locator("html")).toHaveAttribute("data-command-mode", "false");
    await expect.poll(
      async () => page.locator(".carousel-card").count(),
      { timeout: 5000 }
    ).toBeGreaterThan(initialCount);
  });
});

test.describe("Power menus — Cmd+/ picker toggle", () => {
  test.describe.configure({ mode: "serial" });

  let sessionName;

  test.beforeEach(async ({ page, context }, testInfo) => {
    sessionName = await setupLight({ page, context, testInfo });
  });

  test.afterEach(async ({ page }) => {
    await cleanupSession(page, sessionName);
  });

  test("Cmd+/ opens the picker", async ({ page }) => {
    await page.keyboard.press("Meta+/");
    await expect(page.locator(".command-picker")).toBeVisible();
  });

  test("Cmd+/ a second time closes the open picker", async ({ page }) => {
    await page.keyboard.press("Meta+/");
    await expect(page.locator(".command-picker")).toBeVisible();

    await page.keyboard.press("Meta+/");
    await expect(page.locator(".command-picker")).toHaveCount(0);
  });

  test("Esc also closes the picker", async ({ page }) => {
    await page.keyboard.press("Meta+/");
    await expect(page.locator(".command-picker")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".command-picker")).toHaveCount(0);
  });
});

test.describe("Power menus — PWA-mode Cmd+ aliases", () => {
  test.describe.configure({ mode: "serial" });

  let sessionName;

  test.beforeEach(async ({ page, context }, testInfo) => {
    // Force the page to report standalone display-mode BEFORE app boot, so
    // isPwaStandalone() reads true at module load.
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        if (query === "(display-mode: standalone)") {
          return {
            matches: true,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false; },
          };
        }
        return original(query);
      };
    });

    sessionName = await setupLight({ page, context, testInfo, prefix: "pwa" });
  });

  test.afterEach(async ({ page }) => {
    await cleanupSession(page, sessionName);
  });

  test("Cmd+T creates a new terminal", async ({ page }) => {
    const initialCount = await page.locator(".carousel-card").count();

    await page.keyboard.press("Meta+t");

    await expect.poll(
      async () => page.locator(".carousel-card").count(),
      { timeout: 5000 }
    ).toBeGreaterThan(initialCount);
  });

  test("Cmd+/ still opens picker in PWA mode", async ({ page }) => {
    await page.keyboard.press("Meta+/");
    await expect(page.locator(".command-picker")).toBeVisible();
  });

  test("Cmd+; still toggles chord menu in PWA mode", async ({ page }) => {
    await page.keyboard.press("Meta+;");
    await expect(page.locator("html")).toHaveAttribute("data-command-mode", "true");
  });
});
