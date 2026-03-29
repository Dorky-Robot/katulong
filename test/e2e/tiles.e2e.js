/**
 * E2E tests for the tile extension system.
 *
 * API tests verify the server-side extension discovery and file serving.
 * Carousel tests require the tablet project (iPad viewport) for carousel activation.
 */

import { test, expect } from "@playwright/test";
import { setupTest, cleanupSession, waitForAppReady } from "./helpers.js";

test.describe("Tile Extension API", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("extension API returns Plano", async ({ page }) => {
    const response = await page.evaluate(() =>
      fetch("/api/tile-extensions").then(r => r.json())
    );
    expect(response.extensions).toBeDefined();
    const plano = response.extensions.find(e => e.type === "plano");
    expect(plano).toBeDefined();
    expect(plano.name).toBe("Plano");
    expect(plano.icon).toBe("note-pencil");
  });

  test("extension file serving works", async ({ page }) => {
    const res = await page.evaluate(() =>
      fetch("/tiles/plano/tile.js").then(r => ({
        ok: r.ok,
        type: r.headers.get("content-type"),
      }))
    );
    expect(res.ok).toBe(true);
    expect(res.type).toContain("javascript");
  });

  test("extension tala-md.js is served", async ({ page }) => {
    const res = await page.evaluate(() =>
      fetch("/tiles/plano/tala-md.js").then(r => ({
        ok: r.ok,
        type: r.headers.get("content-type"),
      }))
    );
    expect(res.ok).toBe(true);
    expect(res.type).toContain("javascript");
  });

  test("path traversal blocked", async ({ page }) => {
    const res = await page.evaluate(() =>
      fetch("/tiles/plano/../../server.js").then(r => ({ status: r.status }))
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("unknown extension returns 404", async ({ page }) => {
    const res = await page.evaluate(() =>
      fetch("/tiles/nonexistent/tile.js").then(r => ({ status: r.status }))
    );
    expect(res.status).toBe(404);
  });
});

test.describe("Tile SDK loading", () => {
  test.beforeEach(async ({ page }) => {
    // Just navigate to root — don't wait for terminal/shell, we only need the JS to load
    await page.goto("/");
    // Wait for app.js to finish loading (extensions included)
    await page.waitForFunction(() => window.__tiles != null, { timeout: 15000 });
  });

  test("extension types are registered in tile registry", async ({ page }) => {
    // The __tiles global exposes the tile system for testing
    const types = await page.evaluate(() => {
      const tiles = window.__tiles;
      if (!tiles) return { hasTiles: false };
      try {
        // Try creating a plano tile — will throw if type not registered
        const tile = tiles.createTile("plano", {});
        return { hasTiles: true, type: tile.type, hasMount: typeof tile.mount === "function" };
      } catch (e) {
        return { hasTiles: true, error: e.message };
      }
    });
    expect(types.hasTiles).toBe(true);
    expect(types.type).toBe("plano");
    expect(types.hasMount).toBe(true);
  });

  test("Plano tile has correct prototype methods", async ({ page }) => {
    const methods = await page.evaluate(() => {
      const tile = window.__tiles?.createTile("plano", {});
      if (!tile) return null;
      return {
        type: tile.type,
        mount: typeof tile.mount,
        unmount: typeof tile.unmount,
        focus: typeof tile.focus,
        blur: typeof tile.blur,
        resize: typeof tile.resize,
        getTitle: typeof tile.getTitle,
        getIcon: typeof tile.getIcon,
        serialize: typeof tile.serialize,
      };
    });
    expect(methods).not.toBeNull();
    expect(methods.type).toBe("plano");
    expect(methods.mount).toBe("function");
    expect(methods.unmount).toBe("function");
    expect(methods.serialize).toBe("function");
    expect(methods.getTitle).toBe("function");
    expect(methods.getIcon).toBe("function");
  });

  test("Plano tile serializes with noteId", async ({ page }) => {
    const state = await page.evaluate(() => {
      const tile = window.__tiles?.createTile("plano", {});
      if (!tile) return null;
      return tile.serialize();
    });
    expect(state).not.toBeNull();
    expect(state.type).toBe("plano");
    expect(state.noteId).toBeDefined();
    expect(state.title).toBe("Untitled");
  });

  test("Plano tile restores with saved noteId", async ({ page }) => {
    const result = await page.evaluate(() => {
      const tile1 = window.__tiles?.createTile("plano", {});
      if (!tile1) return null;
      const saved = tile1.serialize();
      // Create second tile from saved state
      const tile2 = window.__tiles?.createTile("plano", saved);
      const restored = tile2.serialize();
      return { saved, restored, match: saved.noteId === restored.noteId };
    });
    expect(result).not.toBeNull();
    expect(result.match).toBe(true);
  });

  test("different Plano tiles get different noteIds", async ({ page }) => {
    const result = await page.evaluate(() => {
      const tile1 = window.__tiles?.createTile("plano", {});
      const tile2 = window.__tiles?.createTile("plano", {});
      if (!tile1 || !tile2) return null;
      return {
        id1: tile1.serialize().noteId,
        id2: tile2.serialize().noteId,
      };
    });
    expect(result).not.toBeNull();
    expect(result.id1).not.toBe(result.id2);
  });

  test("Plano appears in + menu on carousel devices", async ({ page }) => {
    // Check that extension types were loaded into the shortcut bar's tileTypes
    const hasPlano = await page.evaluate(() => {
      // The tile types are passed to the shortcut bar — check the menu
      const addBtn = document.querySelector("#shortcut-bar .tab-bar-add");
      if (!addBtn) return "no-add-btn";
      // Simulate opening the menu and check for Plano
      addBtn.click();
      return new Promise(resolve => {
        setTimeout(() => {
          const menu = document.querySelector(".tab-context-menu");
          if (!menu) { resolve("no-menu"); return; }
          const hasPlano = menu.textContent.includes("New Plano");
          menu.remove(); // clean up
          resolve(hasPlano ? "found" : "not-found");
        }, 500);
      });
    });
    expect(hasPlano).toBe("found");
  });
});
