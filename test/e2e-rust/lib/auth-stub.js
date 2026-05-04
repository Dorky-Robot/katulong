/**
 * Stub `/auth/status` to look like a remote caller with
 * credentials already enrolled — i.e., the sign-in form
 * should render. The cutover (phase 0a-1) reshaped this
 * endpoint to `{setup, accessMethod}` (Node-compatible);
 * `authenticated` is gone and `has_credentials` was renamed
 * to `setup`.
 *
 * `setup: true` means the WASM probe routes to `SignedOut`
 * (sign-in form). `setup: false` + `accessMethod:
 * "localhost"` would route to the first-device register
 * flow; the unit-test default here picks "remote, signed
 * out" because that's the path most login-UI tests want.
 *
 * Must be called BEFORE `page.goto()`. Once the WASM has
 * mounted and fired the probe, intercepting won't roll
 * back the in-flight request.
 */
export async function stubUnauthenticated(page) {
  await page.route("**/auth/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        setup: true,
        accessMethod: "remote",
      }),
    }),
  );
}
