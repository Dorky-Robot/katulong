# Auth-as-a-Service — design proposal

> **Destination:** move this file to `~/Projects/dorky_robot/katulong/AUTH-AS-A-SERVICE.md` after review.
> **Status:** draft for alignment, not yet implemented.
> **Owner:** TBD (likely a katulong-app/1 follow-up)
> **Adjacent docs:** `docs/dorkyrobot-stack.md`, `docs/session-identity.md`, `SECURITY.md`

## Problem

Each app in the dorky-robot stack that needs human sign-in is starting to grow its own WebAuthn implementation:

- **katulong** (Node.js) ships passkey register/login at `/auth/register/options`, `/auth/login/options`, etc.
- **sipag** just landed (Track A #36–#38) a port of the same flow in Rust under `sipag-core/src/auth/` — `webauthn.rs`, `setup_token.rs`, `session.rs`, `credential.rs`, `store.rs`. Functionally a duplicate of katulong's flow with its own state file in `~/.sipag/`.
- The other dorky-robot apps that may need browser auth (diwa search UI, kubo status UI, future ones) are about to make the same choice.

Three problems result:
1. **Reimplementation cost.** WebAuthn is spec-heavy. Every Rust port of katulong's flow drags in `webauthn-rs` and the same passkey/setup-token/session/store machinery.
2. **Multiple credential silos.** A user registers a passkey for katulong on their iPad, then has to register a *separate* passkey for sipag on the same iPad. There is no good reason for that.
3. **Drift risk.** If we patch a security issue in one implementation, the others lag.

## Goal

Make any katulong peer able to issue identity tokens that other dorky-robot apps trust. Apps verify a user's identity by checking a token signed by a katulong peer they have paired with, rather than running their own WebAuthn ceremony.

There is no central authority. Each katulong instance (mini, prime, og, future) is a sovereign peer with its own signing keypair. An app can pair with one or many peers; a user signs in via whichever paired peer they happen to be near. The mesh grows the same way the existing katulong client mesh grows — by reusing the host↔client pairing ceremony, with apps occupying the "client" role.

A user registers a passkey **once per katulong peer they use** (the existing model — unchanged) and is then signed-in to every app that trusts that peer.

## Mental model: passkeys are "yep", not identity

In katulong's existing design the passkey is **not** the auth token. It's a high-assurance "yes, I'm a real human and I approve this" gesture, gating actions that would be catastrophic if approved by mistake. Pairing a new device grants shell access — that's risky, so it requires a passkey to confirm. This proposal extends the same gesture to all the other risky actions in the stack.

**Risky actions that require a passkey gesture:**
- Pairing two katulong peers (the operator at *each* peer confirms — the action is bilaterally risky, so confirmation is bilateral).
- Issuing an API key for an app to use against this peer (passkey-gated by the existing katulong API-key issuance flow — no new ceremony invented for app pairing).
- Issuing a token to an app on behalf of a user — i.e. login ("yep, approve this sipag session").
- Registering a new passkey on a peer (existing flow, unchanged).

**App↔peer pairing reuses the existing API-key flow** rather than inventing a new ceremony. An app is "paired with" a peer when the operator has issued the app an API key on that peer. The API key is the app's credential to the peer; the trust anchor (peer URL + public keys) is what the app needs to verify tokens. No new pair-handshake endpoint, no peer-side passkey-confirm-on-app-pair — the passkey gate is the one already on API-key issuance.

**What actually carries trust** is not the passkey — it's the keys exchanged during pairing and the tokens those keys sign. The passkey is just the bouncer at the door of every pairing or token-issuance ceremony. After pairing, steady-state operations don't touch the passkey at all; they verify signatures against cached public keys.

This is why the federated peer model fits naturally: each peer's signing key is the identity-bearer for tokens it issues, and pairing is how trust in those keys is established. The passkey gates pairing and gates issuance — it never appears on the wire between systems and never travels to apps.

## Three options considered

### A — Shared library
Apps don't run WebAuthn endpoints. They link a shared crate / Node module that reads katulong's state file (`~/.katulong/auth.json`) directly.

- ✅ No network hop.
- ❌ Cross-process write contention on the auth state file.
- ❌ Two language stacks (Rust + Node) have to stay in lockstep on the file format.
- ❌ Doesn't actually unify the user-visible login flow — each app still ships its own `/login` page.

### B — Centralized IdP (one katulong is "the" auth server, OAuth2-shaped)
Pick a designated katulong instance. Every app redirects unauthenticated users to *it*, it runs the ceremony and issues tokens.

- ✅ Industry-standard.
- ❌ Single point of failure — if the designated peer is down, no app can authenticate new sessions.
- ❌ Conflicts with the existing katulong topology, where every device is a peer of equal standing. There is no natural "primary".
- ❌ A lot of plumbing: redirect URI registration per app, code+state CSRF protection, refresh-token rotation.
- ❌ Cross-origin cookie behavior under Cloudflare tunnels is fiddly (every app is a different `*.felixflor.es` subdomain).
- ❌ Heavy for a stack run by one person on three machines.

### C — Federated peer issuers (recommended)
Every katulong peer is a token issuer. Each peer has its own asymmetric signing keypair (Ed25519). The private key never leaves the peer; the public key is published at the peer's JWKS endpoint.

Apps pair with one or more katulong peers using the same setup-token + WebAuthn ceremony devices already use. Pairing establishes a trust anchor: the app caches the peer's `(issuer, public_keys)`. From then on, the app accepts any token whose signature verifies against a trust-anchor public key and whose `iss` matches that peer.

A user signs in via whichever paired peer is convenient (mini at home, prime in the office). Same human, two issuers — apps that care can merge identities; apps that don't treat `(iss, sub)` as the identity tuple.

- ✅ Reuses the existing host↔client mental model and ceremony — no new auth UX to design.
- ✅ Apps don't need to implement WebAuthn at all.
- ✅ Stateless per-request verification — no HTTP hop after pairing.
- ✅ Compromising one peer compromises only the tokens issued by that peer's key. Other peers and other apps are unaffected because verifiers hold public keys, not shared secrets — a compromised app cannot forge tokens for other apps.
- ✅ No single point of failure: any paired peer can authenticate.
- ✅ Tokens carry `iss` (issuing peer), `aud` (which app) and `cap` (capability scope) so we get audience separation for free.
- ⚠️ We design a token format. (But it's small — see below.)
- ⚠️ Apps with multiple paired peers need a "which peer do I sign in with" picker on first use.

**Recommendation: option C.**

## Proposed shape (option C)

### Wire format

`Bearer <token>` where token is JWS-shaped (RFC 7515), conforming to OIDC `id_token` conventions so off-the-shelf OIDC client libraries can verify it:

```
base64url(header).base64url(payload).base64url(signature)
```

- `header`: `{ "alg": "EdDSA", "kid": "<key-id>" }` — Ed25519 (RFC 8037). Verifiers stay tiny (single libsodium / `ring` call) and asymmetric signing means apps can verify without holding any secret that could mint a token.
- `payload`: `{ "iss": "<peer-url>", "sub": "<user-handle>", "aud": "<app-id>", "exp": <unix>, "iat": <unix>, "jti": "<uuid>", "scope": "<space-separated scopes>", "human_id": "<stable cross-peer UUID>", "same_as": [{ "iss": "<other-peer-url>", "human_id": "<their UUID>" }, ...] }`
- `signature`: `Ed25519_sign(private_key_for_kid, header.payload)`

`iss` is the canonical URL of the issuing katulong peer (e.g. `https://katulong-mini.felixflor.es`). Apps look up the trust anchor for that `iss`, verify the signature against the public key for `kid`, and reject tokens from issuers they have not paired with.

`human_id` is a stable per-human UUID, generated by the issuing peer at first passkey registration. **Apps key off `human_id`, not `(iss, sub)`** — this is what avoids the "same human signs in via two peers, looks like two users" problem. `same_as` carries cross-peer equivalents established during peer↔peer pairing (see below); apps that see a new `human_id` should check `same_as` for an already-known equivalent before treating it as a fresh user.

`scope` is a space-separated string per OAuth 2.0 convention (RFC 6749 §3.3) — not an array — so existing JWT/OIDC libraries parse it without custom code.

Each peer's signing private key lives only on that peer (under `~/.katulong/peer-keys/`, generated on first boot, never transmitted). Public keys are published at `GET /auth/peer/jwks` on each peer.

**Token delivery uses OAuth 2.1 authorization-code-with-PKCE** (RFC 7636) — never via URL. The full delivery flow is in §"First-time login flow" below; the short version is: peer redirects back with a one-time `code`, app exchanges `code + code_verifier + api_key` server-side at `/auth/token` to get the JWT in the HTTP response body. This avoids tokens leaking via `Referer`, browser history, or proxy logs (the failure mode of the deprecated implicit grant).

### Endpoints each katulong peer adds

**Peer↔peer pairing (mutual passkey confirmation):**

| Endpoint | Purpose |
|----------|---------|
| `POST /auth/mesh/pair/request` | Initiator generates a one-time pair request. Operator-only (passkey-gated UI). Returns `{ url, expires_in }` — the URL embeds the request token and points back to this peer's `/auth/mesh/pair/info`. Operator shares the URL with the other peer's operator. |
| `GET  /auth/mesh/pair/info?token=<>` | Receiver hits this to fetch the initiator's metadata: `{ peer_url, peer_name, public_keys, fingerprint, request_id }`. Receiver's UI displays the fingerprint for visual confirmation before asking for passkey. |
| `POST /auth/mesh/pair/accept` | Receiver POSTs to this on the *initiator* after the operator at the receiver passkey-confirms. Body: `{ request_id, peer_url, peer_name, public_keys, signed_acceptance }`. Initiator validates signature, then surfaces the request to its own operator for passkey confirmation. |
| `POST /auth/mesh/pair/finalize` | Called internally by initiator's UI once *its* operator passkey-confirms. Stores receiver's public keys as a trust anchor and notifies receiver. Receiver also stores initiator's keys. Pairing complete. |

**App↔peer pairing:** no new endpoint. Pairing is the operator issuing an API key for the app via katulong's existing API-key flow. The API key + the peer's URL is the entire pair record — the app stores `{peer_url, api_key}`, then fetches the peer's public keys on demand from `/auth/peer/jwks` (using the API key) to verify incoming JWTs.

**Token issuance — OAuth 2.1 authorization code + PKCE:**

| Endpoint | Purpose |
|----------|---------|
| `GET  /auth/authorize` | User-facing. Initiates the login. Query params: `client_id` (the API key's public ID, not the secret), `state` (app-generated unguessable nonce, echoed back to defeat CSRF), `code_challenge` (base64url of `SHA256(code_verifier)`), `code_challenge_method=S256`, `redirect_uri` (must match the URL registered at API-key issuance — peer rejects mismatches to prevent open-redirector). Peer runs the existing passkey ceremony if the user isn't already signed in at this peer, then mints a one-time `code` (single-use, ~30s TTL, bound to `client_id` + `code_challenge` + the freshly-authenticated user) and redirects to `<redirect_uri>?code=<code>&state=<state>`. The token is **not** in this URL. |
| `POST /auth/token` | Server-to-server (app to peer). Body: `{ grant_type: "authorization_code", code, code_verifier, client_id }`. `Authorization: Bearer <api_key>` required. Peer verifies: code is unused, not expired, bound to this `client_id`, and `SHA256(code_verifier) == code_challenge`. If valid, signs a JWT for the user with `aud` derived from the API key (request body cannot override) and returns `{ access_token, refresh_token, expires_in, token_type: "Bearer" }` in the response body. |
| `POST /auth/token` (refresh) | Same endpoint, body: `{ grant_type: "refresh_token", refresh_token, client_id }` + API key. Returns a new `access_token` (and rotated `refresh_token`). Refresh tokens are single-use; reuse detection invalidates the entire refresh chain (RFC 6749 §10.4 / OAuth 2.1 §6.1). This replaces the previous redirect-based renewal flow. |

**Verification helpers:**

| Endpoint | Purpose |
|----------|---------|
| `GET  /.well-known/openid-configuration` | OIDC discovery document (RFC 8414 / OIDC Discovery). Publishes `issuer`, `jwks_uri`, `authorization_endpoint`, `token_endpoint`, `introspection_endpoint`, supported algorithms (`EdDSA`), supported scopes, etc. Lets apps auto-configure given just the peer URL. Public, unauthenticated. |
| `GET  /auth/peer/jwks` | Verification keys for this peer: `{ issuer, peer_name, keys: [{ kid, alg, kty, crv, x }] }`. Public keys only — no secret material. Requires `Authorization: Bearer <api_key>` so the peer can rate-limit / revoke per-app. Apps cache by `kid` and refresh on miss. |
| `POST /auth/introspect` | Token introspection (RFC 7662). Body: `{ token }` + API key. Returns `{ active, iss, sub, aud, scope, exp, human_id }`. Stateless verification is preferred; this exists for apps that don't want to ship a verifier. |

The existing `/auth/register/*`, `/auth/login/*`, `/auth/device-auth/*`, `/auth/logout`, `/auth/status` are unchanged. Pair tokens (peer↔peer and app↔peer) reuse the existing setup-token machinery, with a `purpose:` discriminator so a token minted for one ceremony cannot be redeemed at the wrong endpoint.

### Peer↔peer pairing flow (mutual + cross-peer identity binding)

Concrete walk-through of the conceptual flow ("operator at A requests, B and A both confirm with passkey, keys are exchanged, operator's identity is bound across peers"):

1. **Initiator (Peer B)**: operator clicks "Pair with another peer" in B's UI. B mints a one-time pair-request and shows a URL: `https://peer-B.example/pair?token=<one-time>`. The URL embeds B's identity and a fingerprint.
2. **Receiver (Peer A)**: operator pastes B's URL into A's UI. A fetches `/auth/mesh/pair/info` from B to get B's metadata. A's UI shows: "Peer B (`https://peer-B.example`, fingerprint `xxxx-yyyy-zzzz`) wants to pair. Confirm with passkey?"
3. **Receiver passkey-confirms**: operator at A passkey-confirms ("yep"). The passkey identifies a specific human at A; A captures that human's `human_id_A`. A signs an acceptance with A's own private peer key and POSTs `/auth/mesh/pair/accept` to B with `{public_keys, fingerprint, operator_human_id: human_id_A}`.
4. **Initiator passkey-confirms**: B's UI now shows: "Peer A (`https://peer-A.example`, fingerprint `aaaa-bbbb-cccc`) accepted. Confirm pairing with passkey?" Operator at B passkey-confirms ("yep") — B captures that human's `human_id_B`.
5. **Both sides finalize**: B stores A's public keys as a trust anchor and records `{paired_peer: A, their_human_id: human_id_A, my_human_id: human_id_B}` (the operator on each side just proved they are the same human via the bilateral passkey gates). B notifies A with `{public_keys, operator_human_id: human_id_B}`; A records the inverse mapping.
6. **Identity binding propagates into tokens**: from now on, when B issues a JWT for the operator-human, the token carries `human_id: human_id_B` plus `same_as: [{iss: peer-A, human_id: human_id_A}]`. Likewise for tokens minted by A. Apps see the `same_as` and treat them as the same user.

The two-sided passkey confirmation does double duty: it gates the trust grant *and* binds the operator's identity across peers. A stolen URL alone cannot complete pairing (attacker needs passkey access on both devices), and a successful pair automatically resolves the identity-collision problem for the operator without any new ceremony.

**Limitation (v1):** the bilateral pair binds only the *operators'* identities. If a non-operator human registers passkeys on both peers and uses an app paired with both, that human appears as two separate identities until they explicitly run a per-human bind (TBD: probably "open peer-prime in a tab while signed in to peer-mini and click 'bind these accounts' — passkey-confirm on each side"). For dorky-robot's actual user base (one human), this limitation doesn't bite.

### What apps implement

**One-time per peer (pairing = API-key issuance):**
1. Operator goes to katulong peer's UI (or CLI: `katulong api-key new --app <app-id> --redirect-uri <app-callback-url>`) and issues an API key for the app. This is the existing katulong API-key flow — passkey-gated, no new endpoint. The `--redirect-uri` is bound to the API key at issuance and is the *only* `redirect_uri` value the peer will honor for this client; this closes the open-redirector / token-injection class of attacks.
2. Operator pastes `{peer_url, client_id, api_key}` into the app's config (env vars or `~/.<app>/peers.json`). `client_id` is the API key's non-secret public identifier (used in `/auth/authorize` redirects); `api_key` is the secret used for `/auth/token` and JWKS calls.
3. App restarts. On boot, it discovers each peer via `GET <peer_url>/.well-known/openid-configuration` and caches the result. No handshake call required.

The app side has no human present, so the "yep" on that side is the operator's act of pasting the token into config. The peer side has the high-assurance passkey gate. This asymmetry is intentional — apps are services, not people.

**Per request (verifying):**
1. Read `Authorization: Bearer ...` header (or session cookie pointing at cached JWT).
2. Split on `.`, base64url-decode header to find `kid`, decode payload to find `iss`.
3. Look up the peer config for `iss` (matching `peer_url`) in the app's peers list. Reject if not configured (untrusted peer).
4. Look up public key for `kid` in that peer's cached JWKS; if missing, GET `<iss>/auth/peer/jwks` with `Authorization: Bearer <api_key>` and update the cache.
5. Verify Ed25519 signature.
6. Check `aud == <client_id>`, `exp > now()`.
7. **Identity = `human_id`.** If the JWT's `human_id` is unknown, check `same_as[]` for any already-known equivalent — if found, treat this as the same user and add the new `human_id` to the local mapping. If neither is known, this is a new user.

That's it. No passkey state, no setup-token storage, no WebAuthn library, no shared secrets, no app-pair handshake. Off-the-shelf OIDC client libraries handle all of this if pointed at the peer's `/.well-known/openid-configuration` — apps don't have to ship a custom verifier crate.

### First-time login flow (OAuth 2.1 authorization code + PKCE)

1. User opens `https://sipag.felixflor.es/`.
2. sipag has no session cookie. It reads its trust-anchor store and serves a login page listing paired peers ("Sign in with katulong-mini", "Sign in with katulong-prime"). If only one peer is paired, skip the picker and go straight to step 3.
3. User picks a peer. sipag generates a fresh `state` (unguessable nonce, ≥128 bits) and a fresh `code_verifier` (random ≥256 bits), computes `code_challenge = base64url(SHA256(code_verifier))`, and stores `{state, code_verifier, chosen_peer}` in a server-side login-pending record keyed by a short browser cookie.
4. sipag redirects (302) to `<peer-issuer>/auth/authorize?client_id=<sipag-client-id>&state=<state>&code_challenge=<challenge>&code_challenge_method=S256&redirect_uri=https://sipag.felixflor.es/auth/callback&scope=openid`.
5. That katulong peer validates `redirect_uri` matches the value bound to `client_id` at API-key issuance (rejects mismatches). If the user isn't already signed in at this peer, runs the existing passkey ceremony — the "yep, approve this sipag session" gesture.
6. On successful passkey, the peer mints a one-time `code` (~30s TTL, single-use, bound to `client_id` + `code_challenge` + the authenticated user's `human_id`) and redirects back to `https://sipag.felixflor.es/auth/callback?code=<code>&state=<state>`. **The token is not in this URL.**
7. sipag's `/auth/callback` handler looks up the login-pending record by browser cookie, verifies the returned `state` matches the stored one (rejects if not — CSRF defense), and POSTs to `<peer-issuer>/auth/token` with `Authorization: Bearer <api_key>` and body `{ grant_type: "authorization_code", code, code_verifier, client_id }`.
8. The peer verifies the code and `SHA256(code_verifier) == code_challenge`, then returns `{ access_token, refresh_token, expires_in, token_type }` in the response body. The JWT never traverses a URL.
9. sipag verifies the JWT (signature against cached JWKS, `iss` against trust anchor, `aud == client_id`, `exp > now()`). Identity = `human_id`; if unknown, check `same_as[]`.
10. sipag stores `{access_token, refresh_token, exp}` server-side keyed by a fresh sipag session cookie (httpOnly, Secure, SameSite=Lax) and redirects to `/`.
11. Subsequent requests use the sipag session cookie; sipag verifies the cached access_token on each request (cheap local crypto). When the access_token nears expiry, sipag silently refreshes via `/auth/token` with `grant_type=refresh_token`.

### Renewal (refresh tokens, no redirect)

Access tokens are short-lived (proposal: 15 minutes — shorter than the original 1h because revocation latency matters more once we have refresh tokens). When the access token nears expiry, the app POSTs to the issuing peer's `/auth/token` server-side with `{ grant_type: "refresh_token", refresh_token, client_id }` + API key. Peer returns a fresh `{ access_token, refresh_token }` pair. No redirect, no user interaction — the user keeps using the app uninterrupted.

Refresh tokens rotate on every use (single-use), and the peer detects reuse: if a refresh token is presented twice, the entire refresh-token chain for that session is invalidated and the user must re-login. This catches token theft (when both the legitimate app and an attacker try to use the same refresh token) — standard OAuth 2.1 behavior (RFC 6749 §10.4).

Refresh tokens are valid for 30 days, after which the user must re-login via the full code+PKCE flow.

If a peer is unreachable at refresh time, the app surfaces a "session expired, please sign in again" UX and falls back to the peer picker — the user can sign in via any other paired peer that is up. Identity continuity is preserved via `human_id` in the new token.

### Caching / offline behavior

- Apps cache each peer's JWKS indefinitely until a `kid` miss forces a refresh against `<iss>/auth/peer/jwks`.
- Tokens are self-contained, so during an outage of the issuing peer, *already-issued tokens keep working until expiry*. New logins via that peer fail until it returns; new logins via *other* paired peers continue to work. This matches the "katulong is data plane, not blocking" principle from `docs/dorkyrobot-stack.md` and naturally extends it: the mesh degrades peer-by-peer, not all-or-nothing.

## Migration path

1. **Per-peer keypair + human_id assignment.** On boot, each katulong peer generates an Ed25519 keypair if `~/.katulong/peer-keys/` is empty (idempotent, no mesh coordination). At first passkey registration for any human, the peer generates and stores a stable `human_id` UUID for that human.
2. **Land OAuth 2.1 / OIDC endpoints.** `/.well-known/openid-configuration`, `/auth/authorize`, `/auth/token` (with both `authorization_code` and `refresh_token` grants), `/auth/peer/jwks` (API-key-gated), `/auth/introspect`. Extend the existing katulong API-key flow to support `--app <app-id> --redirect-uri <url>` so issued keys carry both `aud` and a registered `redirect_uri` (peer rejects mismatches). Tokens include `human_id` and `same_as[]` claims.
3. **Migrate sipag first, paired with one peer.** Sipag is the obvious starting target — it just stood up a duplicate implementation. Use a stock OIDC client library (e.g. `openidconnect` crate) pointed at the peer's discovery URL; do not ship a custom verifier. Operator issues an API key for sipag with `--redirect-uri https://sipag/auth/callback`, pastes `{peer_url, client_id, api_key}` into sipag config. Replace `sipag-core/src/auth/` with the OIDC client glue. Sipag's `/login` page becomes the peer picker. Delete `webauthn.rs`, `setup_token.rs`, `credential.rs`, `store.rs`; keep `session.rs` for the app's own session table that holds `{access_token, refresh_token, exp}` keyed by browser cookie.
4. **One-shot soak.** Run sipag pointed at one katulong peer for ~1 week. Compare auth telemetry to pre-migration. Validate iPad + desktop + tunnel paths. Validate refresh token rotation and reuse-detection.
5. **Land peer↔peer pairing + identity binding.** `/auth/mesh/pair/*` endpoints + the bilateral passkey-confirm UI on both sides + `human_id` exchange in the pair acceptance/finalize messages. This is its own milestone because the two-sided ceremony has more UX surface than app pairing (which is just API-key issuance).
6. **Add a second paired peer.** Pair two katulong peers using the new mesh pairing flow, then issue a second API key for sipag on the second peer. Exercise the picker. Validate failover (kill the first peer, confirm sipag still authenticates via the second). Validate identity continuity: signing in via peer-prime after peer-mini should resolve to the same sipag user via `same_as[]`.
7. **Document the integration recipe.** Short `docs/auth-client-integration.md` covering: get an API key from each peer you trust (with redirect URI), configure your OIDC client with the peer's discovery URL, render peer picker, handle the callback. Future apps follow this recipe.
8. **Migrate other apps as they need user auth.** No forced migration — apps without a UI don't need this. New apps pair with whichever peers their user expects to use, via the existing API-key flow.

## Out of scope (for now)

- **Service-to-service auth.** This is human-user identity. Inter-service calls (sipag → katulong session API) keep using the existing `apiKey` scheme.
- **Group / role authorization.** `cap` in the token leaves room for it, but a permission model is a separate design.
- **Logout broadcast.** When a user logs out of katulong, we don't actively revoke tokens issued to other apps — they expire naturally within the token lifetime. If we want immediate revocation later, add a `jti` blacklist endpoint or shorten lifetime.
- **Self-hosted SSO replacement.** This is dorky-robot-internal. We're not building a Keycloak alternative.

## Open questions for review

1. **Access-token lifetime.** Proposal: 15 minutes (tightened from 1h now that refresh tokens exist). Shorter = faster revocation, more refresh calls (cheap, server-to-server). Longer = slower revocation. Is 15 min right?
2. **Refresh-token lifetime.** Proposal: 30 days, single-use with rotation, reuse detection invalidates the chain. Standard OAuth 2.1 behavior. Is 30 days right?
3. **Key rotation cadence.** Proposal: each peer rotates its Ed25519 keypair every 90 days, keeps the previous public key in JWKS for one extra cycle so old tokens still verify until expiry. Worth automating, or hand-rotate for now?
4. **Domain layout.** Today: `katulong-mini.felixflor.es`, `sipag.felixflor.es`, etc. The redirect flow assumes the user can reach the chosen peer from the same browser session that's hitting sipag. With Cloudflare Access in front of any of these, the redirect dance gets one extra hop. OK?
5. **Multi-human identity binding.** The bilateral pair flow binds the *operators'* `human_id`s automatically. For non-operator humans who use multiple paired peers, we need a secondary "bind these accounts" ceremony (passkey on each side). Concrete UX TBD; lean toward "open peer-prime in a tab while signed in to peer-mini, click 'bind to peer-prime', passkey on each side". Defer detailed design until we have a multi-human user.
6. **Setup-token flow under this model.** Confirmed: only katulong peers issue setup tokens (for device pairing). Apps never have their own setup-token flow — they get paired via the existing API-key flow, which is a different ceremony. Locked in unless someone objects.
7. **API-key issuance ergonomics for many peers.** When a brand-new app needs to be paired with several peers, the operator currently runs `katulong api-key new --app <app-id> --redirect-uri <url>` on each peer separately. Is that the right UX, or do we want a `--all-peers` shortcut that hits each peer in `~/.katulong/known-peers.json`? Defer until we feel the friction.
8. **Untrusted-peer error UX.** When sipag receives a token whose `iss` doesn't match any configured peer, what does the user see? Lean toward: "This katulong peer (`<iss>`) isn't configured in sipag. Issue an API key for sipag on that peer (`katulong api-key new --app sipag --redirect-uri https://sipag/auth/callback`) and add `{peer_url, client_id, api_key}` to sipag's config."
9. **Fingerprint format for peer↔peer pair UX.** Currently a 12-hex-char string — operators are expected to compare it out-of-band. Real users skip this step (Signal-safety-number problem). Options: QR code with on-device verification, emoji sequence, 6-digit SAS (Short Authentication String à la ZRTP). Defer to a UX iteration after first peer-pair ships.

## What this is NOT

- Not centralized SSO. There is no "primary" or "master" katulong. Every peer is sovereign and equal — apps choose which peers to trust, peers choose which humans to know. The mesh has no root node.
- Not a custom auth protocol. The token issuance side is OAuth 2.1 authorization-code-with-PKCE + OIDC discovery, intentionally — so apps can use stock OIDC client libraries instead of a bespoke verifier. Refresh tokens, `state`, redirect URI registration, JWKS, and introspection all conform to standard RFCs.
- Not full OIDC SSO. We use OIDC's wire formats and discovery, but skip the parts that don't apply to a one-human, peer-to-peer-federated stack: no dynamic client registration, no consent screens, no `id_token` vs `access_token` split (we just have one signed token).
- Not a session manager. Apps still own their own session lifecycle. The token is just an identity assertion the app verifies and then maps to its own session cookie.
- Not a credential-sync mesh. Peers do **not** replicate passkeys, sessions, or auth state. A user registers a passkey on each peer they want to use, exactly as today. The new things are token issuance and a small `human_id` mapping established at peer-pair time — apps trust peer signatures, peers don't trust each other's databases.
- Not "passkey-as-token". The passkey is never transmitted off the device it lives on, never seen by apps, and never used for verification of anything by anyone other than the originating peer. It is a "yep, I'm a real human and I approve this risky action" gesture. Identity travels via signed tokens; the passkey only gates the moments where those tokens (or the keys that sign them) are issued.

## Asks before moving forward

- Confirm the mental model: passkey is a "yep" gesture, never a token; identity travels in peer-signed JWTs; pairing is the trust-establishment step, gated by passkey on the high-stakes side(s).
- Confirm peer↔peer pairing is **bilateral + binds operator `human_id`s** (operator at each peer passkey-confirms — a new ceremony, with cross-peer identity binding as a free byproduct) and app↔peer pairing **reuses the existing API-key flow** (no new ceremony — operator issues an API key with a registered `redirect_uri`, pastes `{peer_url, client_id, api_key}` into the app's config).
- Confirm the federated peer shape (option C) — every katulong peer is its own issuer, no central authority.
- Confirm OAuth 2.1 authorization-code-with-PKCE for token delivery (no token-in-URL), `state` for CSRF defense, `redirect_uri` registration at API-key issuance, refresh tokens with rotation + reuse detection. Apps use stock OIDC client libraries against `/.well-known/openid-configuration`, not a bespoke verifier.
- Confirm Ed25519 + asymmetric verification (apps hold public keys only; compromising an app cannot mint tokens; compromising one peer cannot forge tokens for another).
- Confirm `human_id` (stable per-human UUID, bound across peers via the bilateral pair ceremony) as the identity primitive apps key off of — not `(iss, sub)`.
- Pick numbers for access-token lifetime (15m proposed), refresh-token lifetime (30d proposed), key rotation cadence (90d proposed).
- Confirm the migration order: per-peer keypair + human_id → OAuth/OIDC endpoints → sipag paired via API key → soak → peer↔peer pairing UI with human_id binding → second peer + failover/identity-continuity test → other apps as they need it.
- Answer or defer the open questions in §"Open questions for review".

Once aligned, the implementation lands in roughly three PRs: (1) per-peer keypair + human_id + `/.well-known/openid-configuration` + `/auth/authorize` + `/auth/token` + `/auth/peer/jwks` + `/auth/introspect` + extended API-key issuance with `--redirect-uri`; (2) sipag migration off its own auth module, using a stock OIDC client; (3) `/auth/mesh/pair/*` + bilateral peer-peer pair UI + `human_id` exchange in pair messages.
