import { test, expect } from "@playwright/test";

test.describe("Font consistency", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar");
  });

  test("body computed font-family includes JetBrains Mono", async ({ page }) => {
    const fontFamily = await page.evaluate(() =>
      getComputedStyle(document.body).fontFamily
    );
    expect(fontFamily.toLowerCase()).toContain("jetbrains mono");
  });

  test("Modal headings (h3) inherit mono font", async ({ page }) => {
    // Open shortcuts popup to make a modal h3 visible
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Open shortcuts']").click();
    await expect(page.locator("#shortcuts-overlay")).toHaveClass(/visible/);

    const fontFamily = await page.locator("#shortcuts-overlay h3").evaluate((el) =>
      getComputedStyle(el).fontFamily
    );
    expect(fontFamily.toLowerCase()).toContain("jetbrains mono");
  });

  test("Modal buttons inherit mono font", async ({ page }) => {
    await page.locator("#shortcut-bar .bar-icon-btn[aria-label='Open shortcuts']").click();
    await expect(page.locator("#shortcuts-overlay")).toHaveClass(/visible/);

    const fontFamily = await page.locator("#shortcuts-edit-btn").evaluate((el) =>
      getComputedStyle(el).fontFamily
    );
    expect(fontFamily.toLowerCase()).toContain("jetbrains mono");
  });

  test("Shortcut bar buttons use mono font", async ({ page }) => {
    const escBtn = page.locator("#shortcut-bar .shortcut-btn", { hasText: "Esc" });
    const fontFamily = await escBtn.evaluate((el) =>
      getComputedStyle(el).fontFamily
    );
    expect(fontFamily.toLowerCase()).toContain("jetbrains mono");
  });
});
