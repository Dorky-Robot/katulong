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
  registerFirstDeviceViaApi,
  injectCredential,
  mintSetupToken,
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

  test.beforeAll(async ({ browser, baseURL }) => {
    // Self-heal the data dir if a previous run left
    // credentials behind. Without this, every second run
    // through the suite would 409 in the bootstrap.
    await ensureFreshStagingDataDir(baseURL);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/");
    const vauth = await setupVirtualAuthenticator(page);
    bootstrap = await registerFirstDeviceViaApi(page, vauth);
    setupToken = await mintSetupToken(
      page,
      bootstrap.finishResponse.csrf_token,
      "pair-test-device",
    );
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
    const vauth = await setupVirtualAuthenticator(page);
    // We don't need vauth's handle after setup — it's
    // attached for the page's lifetime.
    void vauth;
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
});
