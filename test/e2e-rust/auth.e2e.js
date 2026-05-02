// Auth ceremony e2e — verifies the Login component's
// URL-driven mode switch and the sign-in WebAuthn ceremony
// wiring. Sibling to `smoke.e2e.js`, which only covers the
// shell layout + WASM bundle.
//
// Slice 9r.1 introduced the form shell + pair/sign-in mode
// swap. Slice 9r.2 wired the sign-in ceremony. Slice 9r.3
// wires the pair ceremony.
//
// We deliberately don't run the full happy-path WebAuthn
// ceremony here — that needs Chromium's CDP virtual
// authenticator (`WebAuthn.addVirtualAuthenticator`), which
// is a separate setup. The tests below cover everything
// EXCEPT the platform credential interaction:
//   - mode swap based on `?setup_token=`
//   - CTA enabled state in idle, both modes
//   - the start-call fires when the user clicks, with the
//     right URL + method per mode (and the right body for
//     pair, since pair/start needs the setup_token)
//   - server rejection renders a visible error region
// The "did the passkey actually verify" assertion belongs in
// a dedicated suite once the virtual authenticator is wired.
//
// Run against a live Rust backend (no test-side server spin-up):
//   KATULONG_BASE_URL=http://127.0.0.1:3050 \
//     npx playwright test --config=playwright.rust.config.js

import { test, expect } from "@playwright/test";
import { stubUnauthenticated } from "./lib/auth-stub.js";

// Every test in this file exercises the login UI. Slice
// 9r.4's probe-on-mount means the WASM only renders the
// login form when the server says `authenticated: false`,
// and on localhost the server auto-authenticates EVERY
// request (security feature: physical access already grants
// root). Without this stub the login form would never
// render and every assertion below would time out.
test.beforeEach(async ({ page }) => {
  await stubUnauthenticated(page);
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
  await expect(login.locator(".cta:not(.cta-secondary)")).toHaveText("Sign in with passkey");
  // Sign-in mode CTA must be enabled in the idle state — the
  // ceremony is wired (slice 9r.2). Disabled-by-default would
  // be a regression that strands users on a dead button.
  await expect(login.locator(".cta:not(.cta-secondary)")).toBeEnabled();
  // No device-name field in sign-in mode.
  await expect(login.locator('input[name="device-name"]')).toHaveCount(0);
});

test("login switches to pair mode with setup_token", async ({ page }) => {
  // Presence of `?setup_token=` flips the form to pair mode
  // — adds the device-name field, swaps title + CTA copy,
  // sets `data-mode="pair"`. Slice 9r.3 wires the ceremony,
  // so the CTA must be enabled in idle (the 9r.2 disabled
  // bit was a placeholder that this slice removes).
  await page.goto("/?setup_token=abcdef0123456789");
  await expect(page.locator("#kat-shell")).toBeVisible({ timeout: 15_000 });

  const login = page.locator("#kat-login");
  await expect(login).toHaveAttribute("data-mode", "pair");
  await expect(login.locator(".title")).toHaveText("Pair this device");
  await expect(login.locator(".cta:not(.cta-secondary)")).toHaveText("Pair with passkey");
  // Pair mode CTA must be enabled now that the ceremony is
  // wired (slice 9r.3). A disabled CTA here would be a
  // regression back to the inert 9r.2 stub.
  await expect(login.locator(".cta:not(.cta-secondary)")).toBeEnabled();
  // Device-name input is intentionally absent: `pair_finish`
  // doesn't carry a name field yet, so rendering an input
  // would silently discard whatever the user typed. Future
  // slice that lands a credential-name schema field will
  // reintroduce it.
  await expect(login.locator('input[name="device-name"]')).toHaveCount(0);
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
  //
  // Note: the start-call is fired through Leptos's
  // `create_action` queue, which means a microtask separates
  // the `click()` and the actual fetch. Setting up
  // `waitForRequest` BEFORE `click()` is the only race-free
  // ordering — the timeout is the safety net, not the primary
  // mechanism.
  await page.goto("/");
  await expect(page.locator("#kat-shell")).toBeVisible({ timeout: 15_000 });

  const requestPromise = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/auth/login/start") && req.method() === "POST",
    { timeout: 5_000 },
  );
  await page.locator("#kat-login .cta:not(.cta-secondary)").click();
  await requestPromise;
});

test("sign-in renders error region on server rejection", async ({ page }) => {
  // When the start endpoint returns a non-2xx (the typical
  // case being 409 on a fresh data dir with no credentials),
  // the UI must render that as a visible error instead of
  // silently swallowing it — otherwise the user has no idea
  // why the button "stopped working." We don't assert the
  // exact message text (the server controls that wording);
  // we just assert that an error region appears with the
  // status code embedded so the failure mode is observable.
  //
  // We use `page.route` to stub the response rather than
  // depending on the live server's auth state. That keeps
  // the test deterministic across staging-script runs (which
  // may or may not have credentials enrolled in the data
  // dir) without changing what the WASM client does on a
  // real 409 — the rendering code path is identical.
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

  await page.locator("#kat-login .cta:not(.cta-secondary)").click();

  // The error <p role="alert"> is the user-visible result.
  // role=alert is what assistive tech reads; we double-check
  // class for the styling hook.
  const error = page.locator('#kat-login .error[role="alert"]');
  await expect(error).toBeVisible({ timeout: 5_000 });
  await expect(error).toContainText("409");
});

test("pair click hits /api/auth/pair/start with setup_token", async ({
  page,
}) => {
  // Slice 9r.3 wires the pair ceremony parallel to sign-in.
  // The first hop is POST /api/auth/pair/start with the
  // plaintext setup_token in the JSON body — the server
  // hashes + looks it up. We assert URL, method, and body
  // because the body is the load-bearing part: a wired
  // button that posts to the right URL but forgets the
  // setup_token would 401 in production and look like
  // "the button does nothing" without diagnostics.
  const SETUP_TOKEN = "abcdef0123456789".repeat(4); // 64 hex chars, real-token shape
  await page.goto(`/?setup_token=${SETUP_TOKEN}`);
  await expect(page.locator("#kat-shell")).toBeVisible({ timeout: 15_000 });

  const requestPromise = page.waitForRequest(
    (req) =>
      req.url().endsWith("/api/auth/pair/start") && req.method() === "POST",
    { timeout: 5_000 },
  );
  await page.locator("#kat-login .cta:not(.cta-secondary)").click();
  const request = await requestPromise;

  // Body shape: `{ setup_token: "<plaintext>" }`. The server
  // accepts only this exact field name; a typo here would
  // make the start call 400 with `JsonBody` deserialization
  // failure, looking like "the button is broken."
  const body = request.postDataJSON();
  expect(body).toEqual({ setup_token: SETUP_TOKEN });
});

test("pair renders error region on server rejection", async ({ page }) => {
  // Symmetric to the sign-in error test. A 401 here is the
  // typical "setup token expired / already redeemed / never
  // issued" case — the user has no other channel to learn
  // why the ceremony failed, so silent failure is a UX trap.
  // Stubbing the response keeps the test deterministic
  // regardless of staging-data state.
  await page.route("**/api/auth/pair/start", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unauthorized", message: "setup token not redeemable" },
      }),
    }),
  );

  await page.goto("/?setup_token=abcdef0123456789");
  await expect(page.locator("#kat-shell")).toBeVisible({ timeout: 15_000 });

  await page.locator("#kat-login .cta:not(.cta-secondary)").click();

  const error = page.locator('#kat-login .error[role="alert"]');
  await expect(error).toBeVisible({ timeout: 5_000 });
  await expect(error).toContainText("401");
});
