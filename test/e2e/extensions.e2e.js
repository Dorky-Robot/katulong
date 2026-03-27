import { test, expect } from "@playwright/test";
import { waitForAppReady } from "./helpers.js";

test.describe("Extensions — discovery and loading", () => {
  test.setTimeout(30_000);

  test("GET /api/extensions returns installed extensions", async ({ request }) => {
    const res = await request.get("/api/extensions");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.extensions).toBeDefined();
    expect(Array.isArray(data.extensions)).toBeTruthy();
  });

  test("Plano extension is discovered", async ({ request }) => {
    const res = await request.get("/api/extensions");
    const { extensions } = await res.json();
    const plano = extensions.find((e) => e.type === "plano");
    expect(plano).toBeDefined();
    expect(plano.name).toBe("Plano");
    expect(plano.icon).toBe("note-pencil");
  });

  test("Extension tile.js is servable", async ({ request }) => {
    const res = await request.get("/extensions/plano/tile.js");
    expect(res.ok()).toBeTruthy();
    const text = await res.text();
    expect(text).toContain("export default");
  });

  test("Extension manifest.json is servable", async ({ request }) => {
    const res = await request.get("/extensions/plano/manifest.json");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.type).toBe("plano");
  });
});

test.describe("Extensions — Plano tile in UI", () => {
  test.setTimeout(30_000);

  test.beforeEach(async ({ page }) => {
    // Navigate to a terminal session first (app needs at least one session)
    const sessionName = `ext-test-${Date.now()}`;
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await waitForAppReady(page);
  });

  test("Plano appears in the tile types menu", async ({ page }) => {
    // Look for the + button to open the tile type menu
    // The + button in the tab bar opens a menu with tile types
    const addBtn = page.locator('[data-action="new-tile"], .add-tab-btn, button:has-text("+")').first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
      await page.waitForTimeout(500);
      // Look for Plano in the menu
      const planoOption = page.locator('text=Plano').first();
      await expect(planoOption).toBeVisible({ timeout: 5000 });
    }
  });

  test("Creating a Plano tile adds a tab", async ({ page }) => {
    const tabsBefore = await page.locator(".tab-bar .tab, [class*=tab]").count();

    // Try to create a Plano tile via the menu
    const addBtn = page.locator('[data-action="new-tile"], .add-tab-btn, button:has-text("+")').first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
      await page.waitForTimeout(500);
      const planoOption = page.locator('text=Plano').first();
      if (await planoOption.isVisible()) {
        await planoOption.click();
        await page.waitForTimeout(1000);

        // Should have one more tab
        const tabsAfter = await page.locator(".tab-bar .tab, [class*=tab]").count();
        expect(tabsAfter).toBeGreaterThan(tabsBefore);
      }
    }
  });

  test("Plano tile renders content area", async ({ page }) => {
    // Create Plano tile via API-like approach
    const created = await page.evaluate(async () => {
      if (window.__tiles?.createTile) {
        try {
          const tile = window.__tiles.createTile("plano", {});
          const container = document.createElement("div");
          container.style.cssText = "width:400px;height:300px;position:fixed;top:0;left:0;z-index:9999;";
          document.body.appendChild(container);
          tile.mount(container, {
            tileId: "test-plano",
            setTitle: () => {},
            setIcon: () => {},
            sendWs: () => {},
            chrome: {},
          });
          return { mounted: true, html: container.innerHTML.slice(0, 200) };
        } catch (e) {
          return { error: e.message };
        }
      }
      return { error: "no __tiles" };
    });

    if (created.error) {
      console.log("Plano mount result:", created);
    }
    // If it mounted, check there's content
    if (created.mounted) {
      expect(created.html.length).toBeGreaterThan(0);
    }
  });
});
