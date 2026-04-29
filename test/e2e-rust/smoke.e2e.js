// Rust backend smoke e2e — verifies the full vertical stack:
// Rust HTTP server serves the trunk-built Leptos bundle, the
// browser fetches + hydrates the WASM, Leptos renders the
// shell into the DOM. This is the regression guard against
// both:
//   - "blank screen": server up but `/` returns nothing
//     visible
//   - "static-only": HTML loads but WASM never hydrates (the
//     bundle is broken / missing / mis-served)
//
// Auth-ceremony tests (login mode swap, sign-in click wiring,
// error rendering) live in `auth.e2e.js` — this file stays
// focused on the layout + bundle plumbing.
//
// Run against a live Rust backend (no test-side server spin-up):
//   KATULONG_BASE_URL=http://127.0.0.1:3050 \
//     npx playwright test --config=playwright.rust.config.js
//
// Caller must `trunk build --release` in `crates/web` first
// (or use `bin/katulong-stage` with KATULONG_STAGE_BACKEND=rust
// — that runs trunk for you).

import { test, expect } from "@playwright/test";
import { stubUnauthenticated } from "./lib/webauthn.js";

test("leptos shell renders header + main + status", async ({ page }) => {
  // The trunk-built `index.html` arrives with an empty
  // `<body></body>`. Leptos's `mount_to_body` populates it
  // AFTER the WASM downloads + hydrates. So if we see a
  // populated body with our component's content, we know:
  //   - Rust server served the HTML and the WASM
  //   - Browser ran the JS glue + downloaded the WASM
  //   - Leptos mounted successfully
  // i.e., the entire vertical works.
  //
  // Stub the status probe to look unauthenticated. On
  // localhost the server auto-authenticates every request
  // (security model: physical access = root-equivalent), so
  // the slice-9r.4 probe would otherwise resolve as
  // `authenticated: true` and the login form — which we want
  // to assert is visible — would never render.
  await stubUnauthenticated(page);
  const response = await page.goto("/");
  expect(response, "GET / should respond").not.toBeNull();
  expect(response.status(), "GET / should be 200").toBe(200);

  // Wait for hydration. `mount_to_body` is sync once the WASM
  // module is initialised, but the WASM fetch + instantiation
  // is async. Playwright's auto-waiting on the shell root
  // handles the race for us — `toBeVisible` polls until the
  // element exists OR the timeout fires.
  //
  // 15s budget: cold CI runners (constrained ARM, GitHub
  // Actions macOS) take 3-8s for non-trivial WASM
  // instantiation. The outer test timeout in
  // playwright.rust.config.js is 30s, so this still leaves
  // headroom for the rest of the test.
  await expect(page.locator("#kat-shell")).toBeVisible({ timeout: 15_000 });

  // Header presence — slice 9q layout primitive. The brand
  // text uses a `kat•ulong` glyph split, so we match
  // case-insensitively on the substring.
  const header = page.locator("#kat-header");
  await expect(header).toBeVisible();
  await expect(header.locator(".brand")).toContainText("kat");
  await expect(header.locator(".brand")).toContainText("ulong");

  // Connection status indicator: starts disconnected (no WS
  // yet). The `data-status` attribute drives the dot color
  // via CSS; future slices flip it to "connected" when WS
  // attach succeeds.
  await expect(header.locator(".status")).toHaveAttribute(
    "data-status",
    "disconnected",
  );
  await expect(header.locator(".status .label")).toHaveText("disconnected");

  // Main content area renders the Login form. Slice 9r.4
  // gates this on the auth probe — with the stubbed
  // unauthenticated response, the WASM resolves
  // `signed_in: Some(false)` and the login form renders.
  const main = page.locator("#kat-main");
  await expect(main).toBeVisible();
  await expect(main.locator("#kat-login")).toBeVisible();
});

test("/health returns ok", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.status(), "/health should be 200").toBe(200);
  expect(await response.text()).toBe("ok");
});

test("WASM bundle is served with reasonable size", async ({ request }) => {
  // The trunk-emitted WASM filename is hashed
  // (`katulong-web-<hash>_bg.wasm`), so we discover it from
  // the index.html that Leptos's bootstrap script references.
  // That keeps the test stable across rebuilds — we don't
  // hard-code the hash.
  const indexResponse = await request.get("/");
  const indexHtml = await indexResponse.text();
  const wasmMatch = indexHtml.match(
    /katulong-web-[0-9a-f]+_bg\.wasm/,
  );
  expect(
    wasmMatch,
    `index.html should reference a hashed katulong-web-*.wasm bundle; got: ${indexHtml.slice(0, 200)}`,
  ).not.toBeNull();

  const wasmResponse = await request.get(`/${wasmMatch[0]}`);
  expect(
    wasmResponse.status(),
    `${wasmMatch[0]} should be 200`,
  ).toBe(200);
  // Floor sanity check: an empty WASM file or a placeholder
  // would slip through if we only checked status. Leptos's
  // hello-world emits ~100 KB; we assert >50 KB so the test
  // catches regressions where the bundle becomes empty.
  const buf = await wasmResponse.body();
  expect(
    buf.length,
    "WASM bundle should be at least 50 KB (Leptos baseline)",
  ).toBeGreaterThan(50 * 1024);
});

// Note: a `/api/me requires auth` smoke check would be wrong
// here — katulong's security model auto-authenticates
// 127.0.0.1 / ::1 (CLAUDE.md security section), so against a
// local Rust binary the route returns 200. Against the public
// tunnel it returns 401 (Host/Origin classification kicks
// localhost-only into remote-auth mode). That nuance belongs
// in a dedicated auth-suite, not this smoke.
