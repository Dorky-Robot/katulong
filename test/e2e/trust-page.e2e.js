import { test, expect } from "@playwright/test";

test.describe("Trust Page - Certificate Download", () => {
  test("should load the trust page", async ({ page }) => {
    await page.goto("/connect/trust");
    await expect(page.locator("h1")).toHaveText("Trust Certificate");
  });

  test("should show a platform-specific download section", async ({ page }) => {
    await page.goto("/connect/trust");

    // At least one platform section should be visible (script ran successfully)
    const visibleSections = page.locator(".platform-section.active");
    await expect(visibleSections.first()).toBeVisible();
  });

  test("should show desktop download section on desktop browsers", async ({ page, browserName }, testInfo) => {
    // Skip on mobile project — mobile UA triggers iOS section instead
    test.skip(testInfo.project.name === "mobile", "Desktop-only test");

    await page.goto("/connect/trust");

    const desktopSection = page.locator("#desktop-section");
    await expect(desktopSection).toBeVisible();

    // iOS and Android sections should be hidden
    await expect(page.locator("#ios-section")).not.toBeVisible();
    await expect(page.locator("#android-section")).not.toBeVisible();
  });

  test("should have a working certificate download link on desktop", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "Desktop-only test");

    await page.goto("/connect/trust");

    const downloadLink = page.locator("#desktop-section a.download-btn");
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveText("Download CA Certificate");
    await expect(downloadLink).toHaveAttribute("href", "/connect/trust/ca.crt");
  });

  test("should show iOS download section on mobile browsers", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "Mobile-only test");

    await page.goto("/connect/trust");

    // Playwright mobile project uses iPhone UA
    const iosSection = page.locator("#ios-section");
    await expect(iosSection).toBeVisible();

    const downloadLink = iosSection.locator("a.download-btn");
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveText("Download Profile");
    await expect(downloadLink).toHaveAttribute("href", "/connect/trust/ca.mobileconfig");
  });

  test("should serve ca.crt with correct content type", async ({ request }) => {
    const response = await request.get("/connect/trust/ca.crt");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/x-x509-ca-cert");
    expect(response.headers()["content-disposition"]).toBe("attachment; filename=katulong-ca.crt");

    const body = await response.text();
    expect(body).toContain("BEGIN CERTIFICATE");
  });

  test("should show desktop install steps", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "Desktop-only test");

    await page.goto("/connect/trust");

    // Wait for desktop section to be active
    await expect(page.locator("#desktop-section")).toBeVisible();

    // Playwright "Desktop Chrome" uses a Linux UA, so non-Mac steps show
    const otherSteps = page.locator("#desktop-steps-other");
    await expect(otherSteps).toBeVisible();
    await expect(otherSteps).toContainText("trusted certificate store");
  });

  test("should show uninstall toggle", async ({ page }) => {
    await page.goto("/connect/trust");

    const toggle = page.locator("#uninstall-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("Uninstall instructions");

    // Content should be hidden initially
    const content = page.locator("#uninstall-content");
    await expect(content).not.toBeVisible();

    // Click to reveal
    await toggle.click();
    await expect(content).toBeVisible();

    // Click again to hide
    await toggle.click();
    await expect(content).not.toBeVisible();
  });

  test("should show platform-specific uninstall steps when expanded", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "Desktop-only test");

    await page.goto("/connect/trust");
    await page.locator("#uninstall-toggle").click();

    const desktopUninstall = page.locator("#desktop-uninstall");
    await expect(desktopUninstall).toBeVisible();
    await expect(desktopUninstall).toContainText("Keychain Access");
  });

  test("should not have CSP violations blocking scripts", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "Desktop-only test");

    const cspViolations = [];
    page.on("console", (msg) => {
      if (msg.text().includes("Content-Security-Policy") || msg.text().includes("CSP")) {
        cspViolations.push(msg.text());
      }
    });

    await page.goto("/connect/trust");

    // If scripts run, platform sections become visible — this proves no CSP block
    const desktopSection = page.locator("#desktop-section");
    await expect(desktopSection).toBeVisible();

    // No CSP violations related to scripts should appear
    const scriptViolations = cspViolations.filter(v => v.includes("script"));
    expect(scriptViolations).toHaveLength(0);
  });
});
