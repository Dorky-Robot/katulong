import { execSync } from "node:child_process";

// Helpers for driving Chromium's CDP virtual WebAuthn
// authenticator from Playwright tests.
//
// The story so far:
//   - The auth.e2e.js suite verifies the UI's REJECTION
//     paths (button wired, request shape right, error
//     region rendered when the server returns non-2xx).
//   - It deliberately avoids the platform credential
//     interaction because Chromium without a virtual
//     authenticator simply rejects every navigator.credentials
//     call, which would mask real bugs in the success path.
//   - This file wires the virtual authenticator so the
//     SUCCESS paths can be exercised: a real credential is
//     minted by the authenticator, signed by the
//     authenticator's CTAP2 stack, verified by the real
//     `webauthn-rs` engine on the server, and the page ends
//     up in the post-auth view because all the wires
//     actually connect.
//
// The CDP API in use:
//   - WebAuthn.enable                    — turn on the domain
//   - WebAuthn.addVirtualAuthenticator   — attach a software
//                                          CTAP2 device
//   - WebAuthn.getCredentials            — extract a minted
//                                          credential's
//                                          private key for
//                                          re-injection in a
//                                          fresh authenticator
//   - WebAuthn.addCredential             — inject a captured
//                                          credential into a
//                                          fresh authenticator
//                                          (so a "different
//                                          page, same user"
//                                          test can sign in
//                                          with the cred from
//                                          the bootstrap)

/**
 * Attach a virtual CTAP2 authenticator to a page.
 *
 * `isUserVerified: true` + `automaticPresenceSimulation:
 * true` together make the authenticator auto-confirm
 * ceremonies without a UV prompt to dismiss — the test
 * exercises the success path by clicking the page's real
 * buttons, not by simulating biometric input.
 */
export async function setupVirtualAuthenticator(page) {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { client, authenticatorId };
}

/**
 * Make sure the staging instance has a fresh data dir.
 *
 * The `register/start` endpoint succeeds only on a fresh
 * install (no credentials registered). On a re-run of this
 * test file, the data dir already holds the credential
 * minted by the previous run; we need to wipe it before the
 * bootstrap can succeed. The simplest robust path is to
 * stop + start staging via the script — that script owns
 * the server-process + data-dir lifecycle, and re-using its
 * shutdown ensures we don't leak the server. After restart,
 * the server is on a (possibly new) port; the test harness
 * is configured against a stable `KATULONG_BASE_URL`, so
 * the staging port allocator must hand back the same port
 * — which it does, because the dynamic-port range starts at
 * 3050 and the previous instance's port is freed by `stop`.
 *
 * Cost: ~2-5s for stop, ~3-8s for start (Rust binary is
 * already built; trunk is no-op-fast on a hot cache). Paid
 * once per run, not once per test.
 */
export async function ensureFreshStagingDataDir(baseURL) {
  const probe = await fetch(`${baseURL}/api/auth/register/start`, {
    method: "POST",
  });
  if (probe.status === 200) {
    // Even though probe succeeded, we just consumed a
    // challenge_id from the in-memory pending map. That's
    // fine — challenges expire on their own and the
    // bootstrap that follows mints its own. No need to
    // reset.
    return;
  }
  if (probe.status !== 409) {
    throw new Error(
      `register/start probe returned ${probe.status} — staging server may not be running or is in an unexpected state`,
    );
  }

  // 409 means credentials already exist. Wipe staging and
  // restart. The script's `stop` reaps the server process
  // AND removes the data dir; subsequent `start` creates a
  // fresh dir.
  try {
    execSync("bin/katulong-stage stop && bin/katulong-stage start", {
      env: {
        ...process.env,
        KATULONG_STAGE_BACKEND: "rust",
        // Slice 9s.5: pin the RP ID to localhost. Without
        // this the staging script defaults to using the
        // public-tunnel hostname for `KATULONG_RP_ID` (so
        // the operator's manual phone-pair flow works); the
        // Playwright suite targets `http://localhost:$port`
        // and would fail with `RPID did not match the origin
        // or related origins` on every WebAuthn assertion.
        KATULONG_STAGE_RP_ID_OVERRIDE: "localhost",
      },
      timeout: 60_000,
      encoding: "utf8",
    });
  } catch (err) {
    // Trim stderr to the tail to keep the test report
    // scannable AND to avoid echoing the entire staging
    // banner (which on the Node backend includes the
    // plaintext setup token — see katulong-stage:723). The
    // tail almost always contains the actual error line.
    const tail = (s) =>
      (s || "").toString().split("\n").slice(-10).join("\n");
    throw new Error(
      `staging restart failed: ${err.message}\n--- stderr (last 10 lines) ---\n${tail(err.stderr)}`,
    );
  }

  // Wait for /health to come back. The staging script's
  // own `wait_for_server` already gates on this internally,
  // so reaching this poll loop after a successful execSync
  // means the server is at least listening — the poll is a
  // belt-and-braces guard for the rare case where the
  // socket is bound but the route table isn't ready yet.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseURL}/health`);
      if (r.ok) return;
    } catch {
      // server not yet listening — retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    "staging server did not return /health=ok within 30s after restart",
  );
}

/**
 * Drive the first-device register ceremony entirely from
 * inside the page so the virtual authenticator handles
 * `navigator.credentials.create()`. We can't run the
 * ceremony from outside the page because the virtual
 * authenticator is bound to the page's CDP session.
 *
 * The server's `/register/start` route is localhost-only and
 * requires no auth, so this only works against a local
 * staging instance. Returns the parsed AuthFinishResponse
 * (`credential_id`, `csrf_token`) — the caller needs the
 * CSRF token to mint a setup token via the authed
 * `/setup-tokens` endpoint.
 *
 * Also captures the credential's private key via
 * `WebAuthn.getCredentials` so subsequent tests can spin up
 * a fresh authenticator and inject the same credential —
 * needed because virtual authenticators are page-scoped.
 */
export async function registerFirstDevice(page, vauth) {
  // The base64url ↔ ArrayBuffer dance is unavoidable: the
  // server speaks JSON-with-base64url over the wire, the
  // browser's WebAuthn API speaks ArrayBuffers. The WASM
  // client uses webauthn-rs-proto's `From` impls; from the
  // test we recreate the conversion in plain JS.
  const finishResponse = await page.evaluate(async () => {
    const b64uToBuf = (s) => {
      const pad = (4 - (s.length % 4)) % 4;
      const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    };
    const bufToB64u = (buf) => {
      const bytes = new Uint8Array(buf);
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    };

    const startResp = await fetch("/api/auth/register/start", {
      method: "POST",
    });
    if (!startResp.ok) {
      throw new Error(
        `register/start returned ${startResp.status} — data dir may not be fresh`,
      );
    }
    const start = await startResp.json();
    const opts = start.options.publicKey;
    opts.challenge = b64uToBuf(opts.challenge);
    opts.user.id = b64uToBuf(opts.user.id);
    if (opts.excludeCredentials) {
      opts.excludeCredentials.forEach((c) => (c.id = b64uToBuf(c.id)));
    }

    const cred = await navigator.credentials.create({ publicKey: opts });

    const credPayload = {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        attestationObject: bufToB64u(cred.response.attestationObject),
      },
    };
    const finishResp = await fetch("/api/auth/register/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challenge_id: start.challenge_id,
        response: credPayload,
      }),
    });
    if (!finishResp.ok) {
      throw new Error(
        `register/finish returned ${finishResp.status} — credential payload may be malformed or challenge expired`,
      );
    }
    return await finishResp.json();
  });

  // Capture the credential dump for later injection. Without
  // this, a fresh page can't sign in as this user — its
  // virtual authenticator has no credentials.
  //
  // Asserting `length === 1` (not just non-empty) catches
  // the unlikely-but-real case where the CDP session
  // already held a credential from a leaked prior context:
  // `credentials[0]` would then be the stale one, the
  // injection in the sign-in test would target the wrong
  // key, and the failure mode would be a confusing
  // "browser-credential-mismatch" message at the assertion
  // step rather than at the boot.
  const { credentials } = await vauth.client.send("WebAuthn.getCredentials", {
    authenticatorId: vauth.authenticatorId,
  });
  if (credentials.length !== 1) {
    throw new Error(
      `virtual authenticator reported ${credentials.length} credentials after register/finish — expected exactly 1`,
    );
  }

  return {
    finishResponse,
    credentialDump: credentials[0],
  };
}

/**
 * Inject a previously-captured credential into a fresh
 * authenticator on a different page. Lets a sign-in test
 * use a credential minted in the bootstrap test without
 * sharing the authenticator instance.
 */
export async function injectCredential(vauth, credentialDump) {
  await vauth.client.send("WebAuthn.addCredential", {
    authenticatorId: vauth.authenticatorId,
    credential: credentialDump,
  });
}

/**
 * Mint a setup token by hitting the authed
 * `/api/auth/setup-tokens` endpoint with the session cookie
 * + CSRF header from the bootstrap. Returns the plaintext
 * token (caller appends to `?setup_token=` in the URL).
 *
 * We use page.evaluate so the request rides on the page's
 * existing cookies. Using Playwright's `request` fixture
 * would lose the cookie context; using `request` with
 * explicit cookie forwarding is more code than this.
 */
export async function mintSetupToken(page, csrfToken, name) {
  return await page.evaluate(
    async ({ csrf, deviceName }) => {
      const resp = await fetch("/api/auth/setup-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Csrf-Token": csrf,
        },
        body: JSON.stringify({ name: deviceName }),
      });
      if (!resp.ok) {
        throw new Error(
          `setup-tokens returned ${resp.status} — CSRF token may be stale or session cookie missing`,
        );
      }
      const body = await resp.json();
      if (!body.plaintext) {
        // An empty plaintext would silently make the pair
        // test navigate to `/?setup_token=` (no value), which
        // the server treats as "no token in URL" and the UI
        // would render the sign-in mode. The test would then
        // fail at the missing pair-CTA, with no signal that
        // the real bug was the empty-token response.
        throw new Error(
          "setup-tokens response had empty `plaintext` field — server may have changed wire format",
        );
      }
      return body.plaintext;
    },
    { csrf: csrfToken, deviceName: name },
  );
}
