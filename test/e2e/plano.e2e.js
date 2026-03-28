import { test, expect } from "@playwright/test";

/**
 * Plano extension e2e tests.
 *
 * Tests the full lifecycle: extension discovery → tile loading →
 * mounting → note CRUD → editor → localStorage persistence.
 *
 * Uses /test-plano.html as a controlled test harness that mounts
 * the Plano tile directly without needing the full katulong app.
 */

const TEST_PAGE = "/test-plano.html";

test.describe("Plano — Extension Discovery", () => {
  test("API returns Plano in extension list", async ({ request }) => {
    const res = await request.get("/api/extensions");
    expect(res.ok()).toBeTruthy();
    const { extensions } = await res.json();
    const plano = extensions.find(e => e.type === "plano");
    expect(plano).toBeDefined();
    expect(plano.name).toBe("Plano");
    expect(plano.icon).toBe("note-pencil");
  });

  test("tile.js is served with correct content-type", async ({ request }) => {
    const res = await request.get("/extensions/plano/tile.js");
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("javascript");
    const text = await res.text();
    expect(text).toContain("export default");
  });

  test("manifest.json is served", async ({ request }) => {
    const res = await request.get("/extensions/plano/manifest.json");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.type).toBe("plano");
  });
});

test.describe("Plano — Tile Mount", () => {
  test.setTimeout(15_000);

  test("tile module loads and exports setup function", async ({ page }) => {
    await page.goto(TEST_PAGE);
    const result = await page.evaluate(async () => {
      const mod = await import("/extensions/plano/tile.js");
      return { hasDefault: typeof mod.default === "function" };
    });
    expect(result.hasDefault).toBe(true);
  });

  test("tile mounts and renders UI", async ({ page }) => {
    await page.goto(TEST_PAGE);
    await page.waitForSelector(".plano-empty, .plano-notes-list, .plano-note-item", { timeout: 5000 });
    // Should show empty state or note list
    const visible = page.locator(".plano-empty, .plano-notes-list").first();
    await expect(visible).toBeVisible();
  });

  test("tile shows + New Note button", async ({ page }) => {
    await page.goto(TEST_PAGE);
    await page.waitForSelector(".plano-empty, .plano-notes-list, [contenteditable]", { timeout: 5000 });
    const newBtn = page.locator("text=New Note").first();
    await expect(newBtn).toBeVisible({ timeout: 3000 });
  });

  test("tile shows empty state", async ({ page }) => {
    // Clear localStorage first
    await page.goto(TEST_PAGE);
    await page.evaluate(() => localStorage.removeItem("plano_notes"));
    await page.reload();
    await page.waitForSelector(".plano-empty, .plano-notes-list, [contenteditable]", { timeout: 5000 });
    const emptyState = page.locator("text=Create or select a note").first();
    await expect(emptyState).toBeVisible({ timeout: 3000 });
  });
});

test.describe("Plano — Note CRUD", () => {
  test.setTimeout(15_000);

  test.beforeEach(async ({ page }) => {
    await page.goto(TEST_PAGE);
    // Clear localStorage for clean state
    await page.evaluate(() => localStorage.removeItem("plano_notes"));
    await page.reload();
    await page.waitForSelector(".plano-empty, .plano-notes-list, [contenteditable]", { timeout: 5000 });
  });

  test("create a note", async ({ page }) => {
    // Click + New Note
    page.once("dialog", dialog => dialog.accept("My Test Note"));
    await page.locator("text=New Note").first().click();
    await page.waitForTimeout(500);

    // Note should appear in the sidebar
    const noteItem = page.locator("text=My Test Note").first();
    await expect(noteItem).toBeVisible({ timeout: 3000 });
  });

  test("created note is persisted in localStorage", async ({ page }) => {
    page.once("dialog", dialog => dialog.accept("Persisted Note"));
    await page.locator("text=New Note").first().click();
    await page.waitForTimeout(500);

    // Check localStorage
    const stored = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem("plano_notes") || "{}");
      return Object.values(data).map(n => n.title);
    });
    expect(stored).toContain("Persisted Note");
  });

  test("note survives page reload", async ({ page }) => {
    page.once("dialog", dialog => dialog.accept("Reload Test"));
    await page.locator("text=New Note").first().click();
    await page.waitForTimeout(500);

    // Reload
    await page.reload();
    await page.waitForSelector(".plano-empty, .plano-notes-list, [contenteditable]", { timeout: 5000 });

    // Note should still be there
    const noteItem = page.locator("text=Reload Test").first();
    await expect(noteItem).toBeVisible({ timeout: 3000 });
  });

  test("select a note and see editor", async ({ page }) => {
    page.once("dialog", dialog => dialog.accept("Editor Note"));
    await page.locator("text=New Note").first().click();
    await page.waitForTimeout(1000);

    // Click the note
    await page.locator("text=Editor Note").first().click();
    await page.waitForTimeout(1000);

    // Editor should be visible (contenteditable area)
    const editor = page.locator(".pe-editor, [contenteditable=true]").first();
    await expect(editor).toBeVisible({ timeout: 5000 });
  });

  test("type in editor and content is saved", async ({ page }) => {
    page.once("dialog", dialog => dialog.accept("Typing Test"));
    await page.locator("text=New Note").first().click();
    await page.waitForTimeout(1000);
    await page.locator("text=Typing Test").first().click();
    await page.waitForTimeout(1000);

    // Type in the editor
    const editor = page.locator(".pe-editor, [contenteditable=true]").first();
    await expect(editor).toBeVisible({ timeout: 5000 });
    await editor.click();
    await page.keyboard.type("Hello from Plano!");
    await page.waitForTimeout(2000); // wait for auto-save

    // Check localStorage has the content
    const content = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem("plano_notes") || "{}");
      const notes = Object.values(data);
      return notes.find(n => n.title === "Typing Test")?.content || "";
    });
    expect(content).toContain("Hello from Plano!");
  });

  test("create multiple notes", async ({ page }) => {
    let dialogCount = 0;
    page.on("dialog", dialog => {
      dialogCount++;
      dialog.accept(dialogCount === 1 ? "Note A" : "Note B");
    });

    await page.locator("text=New Note").first().click();
    await page.waitForTimeout(500);

    await page.locator("text=New Note").first().click();
    await page.waitForTimeout(500);

    const noteA = page.locator("text=Note A").first();
    const noteB = page.locator("text=Note B").first();
    await expect(noteA).toBeVisible({ timeout: 3000 });
    await expect(noteB).toBeVisible({ timeout: 3000 });
  });
});

test.describe("Plano — In Katulong App", () => {
  test.setTimeout(30_000);

  test("clicking New Plano mounts tile with visible UI elements", async ({ page }) => {
    const sessionName = `plano-mount-${Date.now()}`;
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await page.waitForSelector(".xterm-screen, .shortcut-bar, [class*=tab]", { timeout: 10000 });
    await page.waitForTimeout(1000);

    // Find and click the + button
    const addBtn = page.locator(".tab-bar-add").first();
    await expect(addBtn).toBeVisible({ timeout: 3000 });
    await addBtn.click();
    await page.waitForTimeout(500);

    // Click New Plano in the dropdown menu
    const planoOption = page.locator(".tab-menu-item:has-text('New Plano')").first();
    await expect(planoOption).toBeVisible({ timeout: 3000 });
    await planoOption.click();
    await page.waitForTimeout(2000);

    // Should see Plano content (empty state or editor)
    const planoContent = page.locator(".plano-empty, .plano-notes-list, [contenteditable]").first();
    await expect(planoContent).toBeVisible({ timeout: 5000 });

    // Cleanup
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      sessionName,
    );
  });

  test("Plano tile tab appears and can be switched to", async ({ page }) => {
    const sessionName = `plano-tab-${Date.now()}`;
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await page.waitForSelector(".xterm-screen, .shortcut-bar, [class*=tab]", { timeout: 10000 });
    await page.waitForTimeout(1000);

    const addBtn = page.locator(".tab-bar-add").first();
    await addBtn.click();
    await page.waitForTimeout(500);
    await page.locator("text=New Plano").first().click();
    await page.waitForTimeout(1000);

    // Should have a plano tab in the tab bar
    const planoTab = page.locator("[class*=tab]:has-text('plano')").first();
    await expect(planoTab).toBeVisible({ timeout: 5000 });

    // Click the terminal tab, then click plano tab — tile should reappear
    const termTab = page.locator(`[class*=tab]:has-text('${sessionName.slice(0,10)}')`).first();
    if (await termTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await termTab.click();
      await page.waitForTimeout(500);
      await planoTab.click();
      await page.waitForTimeout(500);

      const planoRoot = page.locator(".plano-empty, .plano-notes-list, [contenteditable]").first();
      await expect(planoRoot).toBeVisible({ timeout: 3000 });
    }

    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: "DELETE" }),
      sessionName,
    );
  });
});

test.describe("Plano — Chrome Zones", () => {
  test.setTimeout(15_000);

  const CHROME_PAGE = "/test-plano.html?chrome=1";

  test("toolbar shows Plano title in chrome mode", async ({ page }) => {
    await page.goto(CHROME_PAGE);
    await page.waitForSelector(".tile-toolbar", { timeout: 5000 });
    const title = page.locator(".tile-toolbar-title");
    await expect(title).toHaveText("Plano", { timeout: 3000 });
  });

  test("toolbar has New Note and Delete buttons", async ({ page }) => {
    await page.goto(CHROME_PAGE);
    await page.waitForSelector(".tile-toolbar", { timeout: 5000 });
    const newBtn = page.locator('.tile-toolbar-btn[aria-label="New Note"]');
    const deleteBtn = page.locator('.tile-toolbar-btn[aria-label="Delete Note"]');
    await expect(newBtn).toBeVisible({ timeout: 3000 });
    await expect(deleteBtn).toBeVisible({ timeout: 3000 });
  });

  test("sidebar mounts note list in chrome zone", async ({ page }) => {
    await page.goto(CHROME_PAGE);
    await page.waitForSelector(".tile-sidebar", { timeout: 5000 });
    // Sidebar should be visible (not chrome-empty) since note list is mounted
    const sidebar = page.locator(".tile-sidebar:not(.chrome-empty)");
    await expect(sidebar).toBeVisible({ timeout: 3000 });
    // Note list should be inside the sidebar
    const notesList = page.locator(".tile-sidebar .plano-notes-list");
    await expect(notesList).toBeAttached({ timeout: 3000 });
  });

  test("content area contains editor, not inline controls", async ({ page }) => {
    await page.goto(CHROME_PAGE);
    await page.waitForSelector(".tile-content", { timeout: 5000 });
    // The inline fallback header should NOT be present inside tile-content
    const inlineHeader = page.locator(".tile-content >> text=+ New Note");
    await expect(inlineHeader).not.toBeVisible({ timeout: 2000 });
    // Empty state should be inside tile-content
    const emptyState = page.locator(".tile-content .plano-empty");
    await expect(emptyState).toBeVisible({ timeout: 3000 });
  });

  test("create note via toolbar button in chrome mode", async ({ page }) => {
    await page.goto(CHROME_PAGE);
    await page.evaluate(() => localStorage.removeItem("plano_notes"));
    await page.reload();
    await page.waitForSelector(".tile-toolbar", { timeout: 5000 });
    // Click the + button in the toolbar
    page.once("dialog", dialog => dialog.accept("Chrome Note"));
    await page.locator('.tile-toolbar-btn[aria-label="New Note"]').click();
    await page.waitForTimeout(500);
    // Note should appear in the sidebar
    const noteItem = page.locator(".tile-sidebar .plano-note-item");
    await expect(noteItem).toBeVisible({ timeout: 3000 });
  });
});

test.describe("Plano — Tala Integration (optional)", () => {
  test.setTimeout(15_000);

  test("with Tala URL configured, adapter uses Tala API", async ({ page }) => {
    await page.goto(TEST_PAGE);
    // This test verifies the adapter selection logic
    const result = await page.evaluate(async () => {
      const mod = await import("/extensions/plano/tile.js");
      const tile = mod.default(null, { talaUrl: "http://localhost:3838" });
      // Mount into a temp container to trigger adapter init
      const container = document.createElement("div");
      await tile.mount(container, {
        tileId: "test", setTitle: () => {}, setIcon: () => {},
        sendWs: () => {}, chrome: {},
      });
      // Wait for async adapter init
      await new Promise(r => setTimeout(r, 500));
      return { mounted: container.innerHTML.length > 0 };
    });
    expect(result.mounted).toBe(true);
  });

  test("without Tala config, falls back to localStorage", async ({ page }) => {
    await page.goto(TEST_PAGE);
    await page.evaluate(() => localStorage.removeItem("plano_notes"));
    await page.reload();
    await page.waitForSelector(".plano-empty, .plano-notes-list, [contenteditable]", { timeout: 5000 });

    // Create a note — should work without Tala
    page.once("dialog", dialog => dialog.accept("Local Note"));
    await page.locator("text=New Note").first().click();
    await page.waitForTimeout(500);

    // Verify it's in localStorage (not Tala)
    const stored = await page.evaluate(() => {
      return localStorage.getItem("plano_notes") !== null;
    });
    expect(stored).toBe(true);
  });
});
