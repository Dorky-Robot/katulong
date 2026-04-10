/**
 * File Browser tile E2E
 *
 * The file-browser is a first-class tile (PR #533). These tests are the
 * regression contracts for the three reported user-visible bugs:
 *
 *   P1/P2 — no phantom file-browser tile on fresh load or after reload
 *   P3/P4/P5/P6 — tab context menu + close paths on the file-browser tile
 *   P7 — terminal tab context menu is unchanged (regression guard)
 *   P8 — file-browser tile fills the carousel cell like a terminal tile
 *
 * The previous version of this file targeted the retired #file-browser
 * overlay (selectors like `.fb-hidden`, aria-label="Close file browser").
 * Those no longer exist — the file browser is now hosted inside a
 * carousel card via tile-chrome.
 */
import { test, expect } from "@playwright/test";
import { setupTest, cleanupSession, waitForAppReady } from "./helpers.js";

const FB_TILE_SELECTOR = '.carousel-card:has(.fb-root)';
const TERMINAL_TILE_SELECTOR = '.carousel-card:has(.terminal-pane)';
async function openFileBrowser(page) {
  // Desktop: sidebar is hidden, so use the tab-bar "+" add menu which
  // exposes a "New Files" item built from tileTypes.
  await page.click(".ipad-add-btn");
  const menu = page.locator(".tab-context-menu, .dropdown-menu, [role=menu]").last();
  await menu.getByText(/New Files/i).click();
  await page.waitForSelector(".fb-miller-col", { timeout: 5000 });
}

test.describe("File Browser tile", () => {
  let sessionName;

  test.afterEach(async ({ page }) => {
    await cleanupSession(page, sessionName);
    sessionName = null;
  });

  test("P1: fresh load (clean storage) has no file-browser tile", async ({ page, context }, testInfo) => {
    // Clear storage on a blank page first, then navigate.
    await page.goto("/");
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    sessionName = await setupTest({ page, context, testInfo });
    // After app is ready, there must be zero file-browser tiles.
    const count = await page.locator(FB_TILE_SELECTOR).count();
    expect(count).toBe(0);
  });

  test("P2: open file browser → reload → no file-browser tile restored", async ({ page, context }, testInfo) => {
    await page.goto("/");
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    sessionName = await setupTest({ page, context, testInfo });

    await openFileBrowser(page);
    await expect(page.locator(FB_TILE_SELECTOR)).toHaveCount(1);

    // Dump what we persisted so failures show the stored shape.
    const stored = await page.evaluate(() =>
      localStorage.getItem("katulong.carousel.v1") || localStorage.getItem("katulong-carousel") || null
    );
    // eslint-disable-next-line no-console
    console.log("[P2] stored carousel state:", stored);

    await page.reload();
    await waitForAppReady(page);

    const count = await page.locator(FB_TILE_SELECTOR).count();
    expect(count).toBe(0);
  });

  test("P3: right-click FB tab → only Close, no Detach/Kill/Open-in-new-window", async ({ page, context }, testInfo) => {
    sessionName = await setupTest({ page, context, testInfo });
    await openFileBrowser(page);

    // The FB tab's data-session is the tile id (`file-browser-*`).
    const fbTileId = await page.locator(FB_TILE_SELECTOR).getAttribute("data-tile-id");
    expect(fbTileId).toMatch(/^file-browser-/);

    const tab = page.locator(`.tab-bar-tab[data-session="${fbTileId}"]`);
    await expect(tab).toBeVisible();
    await tab.click({ button: "right" });

    const menu = page.locator(".tab-context-menu");
    await expect(menu).toBeVisible();
    const labels = await menu.locator(".menu-item, .context-menu-item, [role=menuitem], button, div").allTextContents();
    const joined = labels.join(" | ").toLowerCase();

    expect(joined).toContain("close");
    expect(joined).not.toContain("detach");
    expect(joined).not.toContain("kill session");
    expect(joined).not.toContain("open in new window");
  });

  test("P4: clicking Close in FB tab context menu removes the tile", async ({ page, context }, testInfo) => {
    sessionName = await setupTest({ page, context, testInfo });
    await openFileBrowser(page);

    const fbTileId = await page.locator(FB_TILE_SELECTOR).getAttribute("data-tile-id");
    const tab = page.locator(`.tab-bar-tab[data-session="${fbTileId}"]`);
    await tab.click({ button: "right" });

    const menu = page.locator(".tab-context-menu");
    await expect(menu).toBeVisible();
    // Click the item whose text contains "Close"
    await menu.getByText(/^Close$/i).first().click();

    await expect(page.locator(FB_TILE_SELECTOR)).toHaveCount(0);
  });

  test("P5: component header X removes the tile", async ({ page, context }, testInfo) => {
    sessionName = await setupTest({ page, context, testInfo });
    await openFileBrowser(page);

    const tile = page.locator(FB_TILE_SELECTOR);
    await expect(tile).toHaveCount(1);

    // The file-browser component has its own close button in the header.
    // Prefer any button with an aria-label starting with "Close".
    const closeBtn = tile.locator('button[aria-label*="Close" i]').first();
    await closeBtn.click();

    await expect(page.locator(FB_TILE_SELECTOR)).toHaveCount(0);
  });

  test("P6: two clicks on files button → two independent tiles", async ({ page, context }, testInfo) => {
    sessionName = await setupTest({ page, context, testInfo });
    await openFileBrowser(page);
    await openFileBrowser(page);
    await expect(page.locator(FB_TILE_SELECTOR)).toHaveCount(2);
  });

  test("P7: terminal tab context menu still has Detach and Kill session", async ({ page, context }, testInfo) => {
    sessionName = await setupTest({ page, context, testInfo });
    const tab = page.locator(`.tab-bar-tab[data-session="${sessionName}"]`);
    await expect(tab).toBeVisible();
    await tab.click({ button: "right" });
    const menu = page.locator(".tab-context-menu");
    await expect(menu).toBeVisible();
    const text = (await menu.allTextContents()).join(" ").toLowerCase();
    expect(text).toContain("detach");
    expect(text).toContain("kill session");
  });

  test("P8: FB tile width matches terminal tile width", async ({ page, context }, testInfo) => {
    sessionName = await setupTest({ page, context, testInfo });

    const termBox = await page.locator(TERMINAL_TILE_SELECTOR).first().boundingBox();
    expect(termBox).not.toBeNull();

    await openFileBrowser(page);
    const fbBox = await page.locator(FB_TILE_SELECTOR).first().boundingBox();
    expect(fbBox).not.toBeNull();

    // Same layout slot → widths within 2px.
    expect(Math.abs(fbBox.width - termBox.width)).toBeLessThan(2);
    // And the FB tile should be meaningfully wide (>300px), not a narrow side panel.
    expect(fbBox.width).toBeGreaterThan(300);
  });
});
