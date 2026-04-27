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
// Run against a live Rust backend (no test-side server spin-up):
//   KATULONG_BASE_URL=http://127.0.0.1:3050 \
//     npx playwright test --config=playwright.rust.config.js
//
// Caller must `trunk build --release` in `crates/web` first
// (or use `bin/katulong-stage` with KATULONG_STAGE_BACKEND=rust
// — that runs trunk for you).

import { test, expect } from "@playwright/test";

test("leptos shell renders header + main + status", async ({ page }) => {
  // The trunk-built `index.html` arrives with an empty
  // `<body></body>`. Leptos's `mount_to_body` populates it
  // AFTER the WASM downloads + hydrates. So if we see a
  // populated body with our component's content, we know:
  //   - Rust server served the HTML and the WASM
  //   - Browser ran the JS glue + downloaded the WASM
  //   - Leptos mounted successfully
  // i.e., the entire vertical works.
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

  // Main content area renders the Login form (slice 9r.1).
  // Visible at every page load until a future slice gates
  // it on the authenticated-session signal.
  const main = page.locator("#kat-main");
  await expect(main).toBeVisible();
  await expect(main.locator("#kat-login")).toBeVisible();
});

test("login defaults to sign-in mode without setup_token", async ({ page }) => {
  // No `?setup_token=...` query: Login should render its
  // sign-in mode — no device-name field, "Sign in with
  // passkey" CTA, `data-mode="signin"` for future styling +
  // selector hooks.
  await page.goto("/");
  await expect(page.locator("#kat-shell")).toBeVisible({ timeout: 15_000 });

  const login = page.locator("#kat-login");
  await expect(login).toHaveAttribute("data-mode", "signin");
  await expect(login.locator(".title")).toHaveText("Sign in");
  await expect(login.locator(".cta")).toHaveText("Sign in with passkey");
  // Sign-in mode CTA must be enabled in the idle state — the
  // ceremony is wired (slice 9r.2). Disabled-by-default would
  // be a regression that strands users on a dead button.
  await expect(login.locator(".cta")).toBeEnabled();
  // No device-name field in sign-in mode.
  await expect(login.locator('input[name="device-name"]')).toHaveCount(0);
});

test("login switches to pair mode with setup_token", async ({ page }) => {
  // Presence of `?setup_token=` flips the form to pair mode
  // — adds the device-name field, swaps title + CTA copy,
  // sets `data-mode="pair"`. Slice 9r.2 wires the sign-in
  // ceremony only; the pair ceremony is still inert, so the
  // CTA is disabled to avoid a button that does nothing.
  // 9r.3 will land the pair ceremony and remove the disabled
  // bit.
  await page.goto("/?setup_token=abcdef0123456789");
  await expect(page.locator("#kat-shell")).toBeVisible({ timeout: 15_000 });

  const login = page.locator("#kat-login");
  await expect(login).toHaveAttribute("data-mode", "pair");
  await expect(login.locator(".title")).toHaveText("Pair this device");
  await expect(login.locator(".cta")).toHaveText("Pair with passkey");
  await expect(login.locator(".cta")).toBeDisabled();
  // Pair mode shows the device-name input.
  await expect(login.locator('input[name="device-name"]')).toBeVisible();
});

test("sign-in click hits /api/auth/login/start", async ({ page }) => {
  // The CTA in sign-in mode is wired to dispatch the WebAuthn
  // ceremony (slice 9r.2). We can't run the full ceremony in
  // headless Chromium without a virtual authenticator, but we
  // CAN verify the first hop — the POST to
  // `/api/auth/login/start`. That alone catches the
  // "button does nothing" regression that the slice 9r.1 stub
  // had: the click handler is real, the URL is right, the
  // method is POST.
  await page.goto("/");
  await expect(page.locator("#kat-shell")).toBeVisible({ timeout: 15_000 });

  // Listen for the request before clicking — the start-call
  // is fired synchronously from the click handler so a race
  // here would show up as a flaky test, not a missed call.
  const requestPromise = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/auth/login/start") && req.method() === "POST",
    { timeout: 5_000 },
  );
  await page.locator("#kat-login .cta").click();
  await requestPromise;
});

test("sign-in surfaces server error on fresh install", async ({ page }) => {
  // On a fresh data dir with no credentials, the server's
  // `/api/auth/login/start` returns 409 ("no credentials
  // registered; first device must register…"). The UI must
  // render that as a visible error instead of silently
  // swallowing it — otherwise the user has no idea why the
  // button "stopped working." We don't assert the exact
  // message text (the server controls that wording); we just
  // assert that an error region appears.
  //
  // This test is conditional on a fresh data dir. The Rust
  // staging script (`bin/katulong-stage` in --rust mode)
  // creates a fresh data dir per run, so this holds in the
  // default e2e setup. If a future slice changes that, the
  // test will need a route-mock fallback.
  //
  // Route-stubbing the start endpoint to 409 is the
  // belt-and-suspenders alternative; we use it here so the
  // assertion holds regardless of the server's auth state.
  await page.route("**/api/auth/login/start", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "conflict", message: "no credentials registered" },
      }),
    }),
  );

  await page.goto("/");
  await expect(page.locator("#kat-shell")).toBeVisible({ timeout: 15_000 });

  await page.locator("#kat-login .cta").click();

  // The error <p role="alert"> is the user-visible result.
  // role=alert is what assistive tech reads; we double-check
  // class for the styling hook.
  const error = page.locator('#kat-login .error[role="alert"]');
  await expect(error).toBeVisible({ timeout: 5_000 });
  await expect(error).toContainText("409");
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
