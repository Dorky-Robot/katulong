// Rust backend smoke e2e — the bare-minimum browser-level
// proof that the Rust binary is serving SOMETHING visible at
// `/`. This is the regression guard against the "blank screen"
// failure mode where the Rust binary is healthy on `/health`
// but the operator browses to `/` and sees nothing.
//
// Run against a live Rust backend (no test-side server spin-up):
//   KATULONG_BASE_URL=http://127.0.0.1:3050 \
//     npx playwright test --config=playwright.rust.config.js
//
// Replace this with real frontend coverage once the Leptos
// bundle is built and served at `/`.

import { test, expect } from "@playwright/test";

test("landing page renders rust-backend marker", async ({ page }) => {
  const response = await page.goto("/");
  expect(response, "GET / should respond").not.toBeNull();
  expect(response.status(), "GET / should be 200").toBe(200);

  // Machine-readable marker on <body>. Source of truth for "is
  // the Rust backend serving the placeholder landing page?"
  const body = page.locator("body");
  await expect(body).toHaveAttribute("data-rust-backend", "true");

  // Visible content — catches the "page loaded but is empty"
  // regression where the marker is set but no humans can tell
  // anything is rendering.
  await expect(page.locator("h1")).toContainText("katulong");
  await expect(page.locator("body")).toContainText(
    "Rust backend is alive",
  );
});

test("/health returns ok", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.status(), "/health should be 200").toBe(200);
  expect(await response.text()).toBe("ok");
});

// Note: a `/api/me requires auth` smoke check would be wrong
// here — katulong's security model auto-authenticates
// 127.0.0.1 / ::1 (CLAUDE.md security section), so against a
// local Rust binary the route returns 200. Against the public
// tunnel it returns 401 (Host/Origin classification kicks
// localhost-only into remote-auth mode). That nuance belongs
// in a dedicated auth-suite, not this smoke. The `/health` +
// `/` checks above are enough to catch "blank screen" /
// "binary is dead" regressions.
