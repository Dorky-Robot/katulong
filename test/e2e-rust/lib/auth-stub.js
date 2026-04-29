/**
 * Stub `/api/auth/status` to look like an unauthenticated
 * remote caller. Slice 9r.4 added a probe-on-mount that
 * reads this endpoint to decide between the login form,
 * post-auth view, and "restoring" placeholder. On localhost
 * the server auto-authenticates EVERY request (security
 * feature: physical access is already root-equivalent), so
 * a real probe returns `authenticated: true` and the login
 * form would never render. Tests that exercise the login UI
 * stub the response to look unauthenticated; tests that
 * exercise the real probe behaviour (slice-9r.4 contract
 * verification) skip the stub and let the probe see the
 * server's actual classification.
 *
 * Must be called BEFORE `page.goto()`. Once the WASM has
 * mounted and fired the probe, intercepting won't roll
 * back the in-flight request.
 *
 * `has_credentials: false` reflects the stub's intent for
 * tests that only want the login form to render. When a
 * future slice (9r.5) adds a "no-credentials → register
 * flow" branch in the WASM, this value will need updating
 * to keep these tests on the sign-in path.
 */
export async function stubUnauthenticated(page) {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_method: "remote",
        has_credentials: false,
        authenticated: false,
      }),
    }),
  );
}
