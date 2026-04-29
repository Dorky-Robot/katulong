// End-to-end happy-path WebAuthn ceremonies.
//
// This is the suite that proves the wires actually connect:
// a real credential is minted by Chromium's virtual
// authenticator, the assertion is signed by the
// authenticator's CTAP2 stack, the server's `webauthn-rs`
// engine verifies it, and the page lands on the post-auth
// view because every link in the chain works.
//
// Sibling files cover narrower contracts:
//   - smoke.e2e.js     — shell layout + WASM bundle plumbing
//   - auth.e2e.js      — UI rejection paths (button wired,
//                        request shape right, error region
//                        rendered when server says no)
//
// Why this file is separate: the two sibling suites run
// without a virtual authenticator (the platform credential
// call simply rejects, and we assert the rejection
// rendering). Mixing happy-path tests in would require
// per-test virtual-authenticator setup, and the file would
// quickly drift into "is this a rejection test or a success
// test?" confusion. The split is by what infrastructure the
// test needs.
//
// Data-dir requirement: these tests bootstrap on a fresh
// staging instance. The first test calls `register/start`,
// which is localhost-only and only succeeds when no
// credentials are registered. Re-running the suite against
// the same data dir without restarting will 409 in the
// bootstrap. CI starts a fresh data dir per run; for local
// re-runs use:
//   bin/katulong-stage stop <branch> &&
//     KATULONG_STAGE_BACKEND=rust bin/katulong-stage start
//
// Why use `test.describe.serial` + shared bootstrap state:
// the data dir is one-shot for register-first-device. We
// can register exactly once per test run, so subsequent
// tests must reuse that credential (via `injectCredential`)
// or generate a new one through a flow that doesn't go
// through register (the pair flow). Serial execution + a
// captured credential dump lets each test exercise its own
// UI flow in isolation while sharing the bootstrap cost.

import { test, expect } from "@playwright/test";
import {
  ensureFreshStagingDataDir,
  setupVirtualAuthenticator,
  registerFirstDevice,
  injectCredential,
  mintSetupToken,
  stubUnauthenticated,
} from "./lib/webauthn.js";

test.describe.serial("WebAuthn UI happy paths", () => {
  // Bootstrap output captured in `beforeAll` and read by
  // each test. The bootstrap registers a credential AND
  // captures its private-key dump so the sign-in test on a
  // fresh page can sign in as that user. While still
  // authed, the bootstrap also mints a setup token so the
  // pair test doesn't need to re-sign-in (which would use
  // the credential a second time and trip webauthn-rs's
  // sign-counter replay guard — counters only ever go up,
  // and a re-injected credential dump carries the original
  // count).
  let bootstrap;
  let setupToken;
  // The session cookie minted by `register/finish` during
  // bootstrap. Captured here so test 3 can establish a
  // session via cookie-injection rather than running
  // another ceremony — re-using the bootstrap credential
  // for a UI sign-in trips the sign-counter replay guard,
  // and we've already consumed the bootstrap setupToken
  // (test 2 takes it). Cookie injection is the cleanest
  // way to set up "authed user opens the app" without
  // burning more credentials/tokens.
  let sessionCookie;

  test.beforeAll(async ({ browser, baseURL }) => {
    // Self-heal the data dir if a previous run left
    // credentials behind. Without this, every second run
    // through the suite would 409 in the bootstrap.
    await ensureFreshStagingDataDir(baseURL);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/");
    const vauth = await setupVirtualAuthenticator(page);
    // `bootstrap.credentialDump` carries a PKCS#8 private
    // key for the just-minted credential. It only lives in
    // JS memory, never in the DOM — but never log it,
    // serialize it to disk, or pass it through
    // `page.evaluate` (where it would land in Playwright's
    // trace recording). The dump exists only so a fresh
    // page in the sign-in test can inject the same
    // credential into a new authenticator.
    bootstrap = await registerFirstDevice(page, vauth);
    setupToken = await mintSetupToken(
      page,
      bootstrap.finishResponse.csrf_token,
      "pair-test-device",
    );

    // Snapshot the session cookie before the bootstrap
    // context closes. The cookie is HttpOnly + SameSite=Lax;
    // `context.cookies()` returns the full descriptor that
    // `addCookies` accepts as-is.
    const cookies = await context.cookies();
    sessionCookie = cookies.find((c) => c.name === "katulong_session");
    if (!sessionCookie) {
      throw new Error(
        "expected katulong_session cookie after register/finish",
      );
    }

    await context.close();
  });

  test("a registered user can sign in with their passkey", async ({
    browser,
  }) => {
    // Fresh page so the bootstrap's session cookie isn't in
    // play — we want to see the login form, click "Sign
    // in", and end up at the post-auth view.
    const context = await browser.newContext();
    const page = await context.newPage();
    // Localhost auto-auth would skip past the login form
    // before we can click the CTA; stub the status probe so
    // the WASM resolves to "not signed in" and renders the
    // login UI we're trying to exercise.
    await stubUnauthenticated(page);
    await page.goto("/");

    // Bootstrap minted the credential in a different
    // browser context, whose virtual authenticator is gone.
    // Inject the same credential into this page's
    // authenticator so navigator.credentials.get() can find
    // it.
    const vauth = await setupVirtualAuthenticator(page);
    await injectCredential(vauth, bootstrap.credentialDump);

    await page
      .getByRole("button", { name: /sign in with passkey/i })
      .click();

    // Behaviour-level assertion: after the ceremony, the
    // post-auth view replaces the login form. We don't
    // poke at internal data-attrs; we look for what a user
    // would see.
    await expect(page.getByText(/signed in/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: /sign in with passkey/i }),
    ).toHaveCount(0);

    await context.close();
  });

  test("a setup-token holder can pair a new device", async ({ browser }) => {
    // The setup token was minted in the bootstrap. From a
    // fresh context with a fresh authenticator (no shared
    // credentials with the first device), navigate to the
    // pair URL and click the CTA. The virtual authenticator
    // mints a brand-new credential; the server links it to
    // the consumed setup token and issues a session cookie.
    const context = await browser.newContext();
    const page = await context.newPage();
    // The authenticator is attached for the page's
    // lifetime; we don't need its CDP handle here so we
    // don't bind the return value.
    await setupVirtualAuthenticator(page);
    // Stub the probe so the pair UI (gated on the same
    // tri-state signal as login) actually renders — see
    // the sign-in test for the full rationale.
    await stubUnauthenticated(page);
    // The setup token rides the URL because that's the
    // pairing flow's designed entry point — the operator
    // gives the new device a `?setup_token=` URL. The
    // token is a test fixture on a wiped data dir; do NOT
    // copy this pattern with a real token, since
    // Playwright's trace recorder captures URLs and a
    // production token would persist in trace artifacts.
    await page.goto(`/?setup_token=${setupToken}`);

    await page.getByRole("button", { name: /pair with passkey/i }).click();

    await expect(page.getByText(/signed in/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: /pair with passkey/i }),
    ).toHaveCount(0);

    await context.close();
  });

  test("an active session restores after a page reload", async ({
    browser,
  }) => {
    // The slice 9r.4 contract: a valid session cookie at
    // page load means the user lands on the post-auth view,
    // not the login form. Without the on-mount status
    // probe, every reload would briefly flash through the
    // sign-in screen — observable as a visible login form
    // for ~100ms before the WASM realised it was authed.
    //
    // We exercise the contract via cookie injection rather
    // than another UI sign-in: the bootstrap credential's
    // signCount is frozen in the dump and would trip the
    // replay guard on a second use, and we've already
    // consumed the only setup token. Direct cookie
    // injection isolates THIS slice's contract — the
    // mechanism that established the session is irrelevant
    // here; what matters is that the WASM's on-mount probe
    // observes the cookie and renders accordingly.
    const context = await browser.newContext();
    await context.addCookies([sessionCookie]);
    const page = await context.newPage();
    await page.goto("/");

    // First load: the probe resolves to authenticated=true
    // and the post-auth view renders without the user
    // touching anything.
    await expect(page.getByText(/signed in/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: /sign in with passkey/i }),
    ).toHaveCount(0);

    // Reload: same cookie, fresh WASM mount, fresh probe.
    // Same outcome — never flash through the login form.
    await page.reload();
    await expect(page.getByText(/signed in/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: /sign in with passkey/i }),
    ).toHaveCount(0);

    await context.close();
  });
});
