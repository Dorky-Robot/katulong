# Auth-as-a-Service — design review

> **Reviewing:** [`AUTH-AS-A-SERVICE.md`](./AUTH-AS-A-SERVICE.md), [`AUTH-AS-A-SERVICE-FLOWS.md`](./AUTH-AS-A-SERVICE-FLOWS.md)
> **Status:** review notes for the next revision pass.
> **Lens:** security, UX, industry-standards alignment.

This is a critical pass. Things that work get a one-liner; things that don't get a paragraph. Findings are tagged **🔴 critical**, **🟡 moderate**, **🟢 minor** by my read.

---

## Part 1 — Security

### What works

- **Asymmetric crypto (Ed25519, public keys only at apps).** A compromised app cannot mint tokens for any other app. This is the biggest single security win over the original HS256 draft.
- **Per-peer keypairs.** Compromising one peer's signing key doesn't forge tokens for another peer. Blast radius is bounded.
- **Bilateral passkey on peer↔peer pair.** A stolen pair URL alone cannot complete the ceremony; both operators must passkey-confirm.
- **API-key rotation / revocation comes free.** Reusing katulong's existing API-key flow means we inherit revocation, audit, rate-limiting without designing them.
- **No shared secrets.** Anywhere. The whole design has clean trust directionality.
- **httpOnly cookie at app for the JWT.** XSS in the app can't read the bearer token from JS.

### 🔴 Critical: token-in-URL is OAuth's deprecated implicit grant

**Where:** flow 3, step 6 of the login flow. Peer redirects to `https://sipag/?_kt=<jwt>`.

**The problem:**
- The token lands in the URL bar, the browser history, the `Referer` header on the next navigation, and any CDN / proxy / analytics that logs URLs.
- This pattern is the **OAuth 2.0 implicit grant**, which **OAuth 2.1 has formally deprecated** specifically because of these leak vectors (see RFC 9700 / OAuth 2.0 Security BCP §2.1.2).
- A "URL fragment is also acceptable" is a half-mitigation: fragments don't go to the server but they still land in history and require JS to extract.
- Mitigation via short TTL doesn't help — even a 60-second-old leaked token is a valid bearer token.

**What industry does instead — authorization code + PKCE:**
1. Peer redirects back with a short-lived `code` (single-use, ~30s TTL), not a JWT.
2. App POSTs the `code` server-side to peer's `/auth/token`, along with a PKCE verifier it generated at login start.
3. Peer returns the JWT in the response body — never in a URL.

This is *more* code than what we have, but it's the standard for a reason. We have a server-side app (sipag) — there's no excuse for the implicit-grant shortcut here.

**Fix priority:** high. Switch to authorization code + PKCE before sipag migration ships.

### 🔴 Critical: no `state` param → CSRF on the redirect-back

**Where:** flow 3, redirect from peer to app.

**The problem:**
- An attacker page can trigger a redirect to `https://katulong-mini/login?return_to=https://sipag/&aud=sipag`. If the user is signed in at the peer, a token gets minted and the user lands on sipag with that token.
- More dangerous: attacker could initiate the flow themselves (with the user's cookie at the peer) and inject the resulting token into the user's sipag session — token-injection / session-fixation.
- Standard OAuth `state` parameter prevents this: app generates an unguessable `state`, includes it in the redirect-out, peer echoes it on redirect-back, app rejects if mismatch. Same idea as a CSRF token.

**Fix priority:** high. Bundle this with the implicit→code switch above; both are part of "make this look like OAuth code+PKCE".

### 🔴 Critical: open-redirect / unrestricted `return_to` and `aud` on `/auth/exchange`

**Where:** main doc endpoints table — `/auth/exchange` body is `{ aud, cap[] }` and the login flow accepts arbitrary `return_to`.

**The problem:**
- Today nothing restricts which `aud` a peer will sign for. An attacker who steals an API key for app A could request a token with `aud=app-B` and the peer would sign it. (Wait — the API key is per-app at issuance, so the peer DOES know which app this key represents. Add a check: `aud` parameter must match the API key's bound app, or be omitted. Doc doesn't currently spell this out.)
- Open redirector: `return_to` accepts any URL → attacker redirects user to attacker-controlled site after a successful login, possibly with a token attached.
- Standard fix: each app registers its allowed `return_to` URIs at API-key-issuance time. Peer rejects redirects to anything else.

**Fix priority:** high. Concrete change: at API-key issuance, operator specifies `app_url` (already in the design); peer enforces `return_to` is a path under that origin.

### 🟡 Moderate: no token revocation

**Where:** "Out of scope" section.

**The problem:**
- 1h TTL means a stolen JWT is valid for up to 1h. With no `jti` blacklist, there is no way to invalidate it sooner.
- For a stack giving shell access (katulong's blast radius), 1h is on the long side.
- Industry pattern: a `/revoke` endpoint (RFC 7009) + a small in-memory blacklist of revoked `jti`s, expiring entries past their token's `exp`.

**Fix priority:** medium. Acceptable for v1 with a shorter TTL (15-30 min). Add `/revoke` in v2.

### 🟡 Moderate: peer URL is the trust identifier — what happens when it changes?

**Where:** main doc, "Wire format" — `iss` is the peer's URL.

**The problem:**
- DNS migration, tunnel re-provisioning, moving from ngrok to Cloudflare — any of these change the URL. All apps' trust anchors break atomically.
- No graceful migration story: apps need their config edited (URL + new API key) on every host move.
- Alternatives: use a stable peer ID (UUID generated on first boot, stored in `~/.katulong/peer-id`) as `iss`, with the URL discoverable via a manifest endpoint. Then URL changes don't invalidate trust anchors.

**Fix priority:** medium. Worth the small extra complexity now to avoid painful migrations later.

### 🟡 Moderate: no audience-binding to API key on the peer side

**Where:** main doc, `/auth/exchange` description.

**The problem:**
- Doc currently allows the app to request `{ aud, cap[] }` arbitrarily. The API key tells the peer which app is calling, but doesn't restrict what `aud` the resulting token is signed for.
- Should be: peer determines `aud` from the API key; the request can only specify `cap[]` (subject to per-key scope limits).

**Fix priority:** medium. Trivial fix — derive `aud` server-side, ignore body.

### 🟡 Moderate: pair-request URL clipboard exfiltration

**Where:** flow 1, phases 1-2.

**The problem:**
- Op-B copies the pair URL to the clipboard. Any background process / browser extension / synced clipboard (iCloud, Windows Cloud Clipboard) can read it.
- Mitigation: bilateral confirmation on Op-A's side AND fingerprint cross-verification, both of which the design has. So the URL alone is not sufficient to compromise. ✅
- But: the URL leak shortens the attacker's window for a social-engineering attack on Op-A ("hey, I'm Op-B, please confirm the pair, fingerprint is xxxx").
- Mitigation: short URL TTL (currently unspecified — should be ≤5 min).

**Fix priority:** low-medium. Make the TTL explicit and short.

### 🟢 Minor: HTTPS-only assumption is implicit

The whole design assumes TLS everywhere. Worth saying explicitly in the security section: tokens, API keys, pair URLs MUST NOT travel over plain HTTP. Local dev exception (localhost-only) should be called out.

### 🟢 Minor: no rate-limiting story for `/auth/exchange`

A peer could be DOS'd by a flood of `/auth/exchange` requests with valid session cookies (forces signature operations). Standard mitigation: per-IP and per-session-cookie rate limit. Probably reuse whatever katulong already does for `/auth/login`.

---

## Part 2 — UX

### What works

- **Single picker UX across the stack.** Once paired, every app shows the same "which peer?" choice. Conceptually simple.
- **Silent renewal.** As long as the user has a recent session at the peer, renewals don't prompt. This is critical — re-passkey-prompting every hour would be miserable.
- **API-key flow for app pairing.** Operators already know this pattern; nothing new to learn.
- **Existing katulong login UX is unchanged.** Nobody has to relearn how to sign in.

### 🔴 Critical: identity collision will bite hard

**Where:** open question #4 in main doc; flow 7 closing note.

**The problem:**
- User signs in via `peer-mini` once → sipag identity = `(mini, <handle>)`.
- Three months later, user signs in via `peer-prime` → sipag sees `(prime, <handle>)` as a **new user**. The user's history, settings, data — all gone, from their perspective.
- The current "apps maintain `(iss, sub) → local_user_id` mapping" answer requires every app to build user-merge UI. They won't. Users will rage.
- This is THE worst UX bug in the proposal. It's not theoretical — it'll happen the first time a user uses a second peer.

**Fix:** promote option (c) from a future-option to a v1 requirement. Peers gossip a stable `human_id` via the existing katulong mesh (or a manual-paste cross-peer identity claim) and put it in the JWT. Apps key off `human_id` instead of `(iss, sub)`. The mesh-gossip story is more complex but it's the difference between "works for one user" and "works for one user with multiple devices", which is the whole audience.

**Fix priority:** high. Without this, the federated peer model creates more pain than it solves for the actual user base.

### 🟡 Moderate: peer picker fatigue

**Where:** flow 3, phase 1.

**The problem:**
- Every app shows the picker on every fresh login. With 5 apps × 5 paired peers, the user picks ~25 times before the apps remember.
- Browsers mostly clear cookies on cache-clear, on profile-switch, etc. — so "remembered last peer" isn't durable.
- Better default: per-app "preferred peer" cookie that survives cache clears (app stores it in IndexedDB or sends a long-lived `last_peer` cookie). When the preferred peer is reachable, redirect immediately. Otherwise show the picker.

**Fix priority:** medium. Polish, but visibly better.

### 🟡 Moderate: fingerprint verification is hand-wavy

**Where:** flow 1, phases 2 and 4.

**The problem:**
- `xxxx-yyyy-zzzz` is meant to be read out loud over Signal/SMS. People will eyeball it. People will assume it matches when it doesn't.
- Signal-app-style "compare 60-digit safety number" is famously skipped by ~99% of users.
- The bilateral confirmation gives some defense even if the fingerprint check fails (attacker still needs Op-B's passkey too), but the fingerprint is the only line of defense against MITM on the URL channel.

**Better UX options:**
- **QR code with on-device verification**: Op-A's UI displays a QR encoding A's fingerprint; Op-B scans it with B's UI; B compares automatically. Actually catches mismatches.
- **Visual fingerprints**: emoji sequence (`🐢🐱🦊🐙`) or color blocks — easier to compare at a glance.
- **Numeric SAS (Short Authentication String)**: a 6-digit code that both sides display and both operators say aloud. Standard in Signal, ZRTP, etc. Easier than 12-hex-char fingerprints.

**Fix priority:** medium. A hex fingerprint is fine for v1, but plan the upgrade.

### 🟡 Moderate: silent breakage on API-key revocation

**Where:** main doc, "Renewal" + the API-key-gated JWKS endpoint.

**The problem:**
- Operator revokes sipag's API key on peer-mini.
- Already-issued JWTs continue verifying for up to 1h (cached public keys still work).
- Once a `kid` rotation happens or the cache is cold, sipag tries to fetch JWKS, gets 401, breaks.
- The user sees: "I can't log in to sipag, what happened?" Operator may have forgotten they revoked.
- No clean signal back to the app. Standard fix: on 401 from JWKS, app surfaces a clear "this peer has revoked our access — operator needs to re-issue an API key" message.

**Fix priority:** medium. Add error-message UX for the revoked-key case.

### 🟡 Moderate: logout doesn't logout

**Where:** "Out of scope" section.

**The problem:**
- User clicks "log out" in sipag. Sipag clears its cookie. User thinks they're logged out.
- They open another tab → app still has a valid (cached) JWT or a session cookie at the peer. Token TTL of 1h means up to 1h of zombie access.
- Even if sipag's logout is local-only, mental-model wise users expect "log out" = "I'm no longer signed in to this thing."

**Fix:** sipag's logout button could also POST to a peer endpoint to revoke the token's `jti`. This needs the revocation endpoint flagged above. Until that exists, the logout button is a UX lie.

**Fix priority:** medium. Couple with the revocation endpoint.

### 🟡 Moderate: peer-pair URL share over chat is awkward

**Where:** flow 1, phase 1→2 transition.

**The problem:**
- "Operator B copies URL, sends to Operator A via Signal" is the happy path described. In reality:
  - You're often the same human at both ends (one human, mini at home + prime at office).
  - Even if two people, picking the right channel mid-pair is friction.
- Better options:
  - **QR code**: B's UI shows QR, A scans with phone camera or paste-from-clipboard.
  - **Same-LAN auto-discovery**: if both peers are on the same network, mDNS announces and skips the URL exchange.
  - **NFC**: tap two devices together (works for one human pairing two of their own devices).

**Fix priority:** low-medium. Hex URL share is acceptable for v1; QR is ~10 lines of code and a big UX win.

### 🟢 Minor: empty-picker state for first-run apps

What does sipag show when a brand-new install has no peers configured? Currently undefined. Should be: "Configure a katulong peer to enable sign-in. See `docs/auth-client-integration.md`."

### 🟢 Minor: cross-device WebAuthn UX in bilateral pair

If Op-B's only passkey is on their phone but they're pairing from a desktop, the bilateral pair flow involves cross-device WebAuthn (QR code, BLE proximity). The doc doesn't mention this — should call out that the existing katulong WebAuthn UX handles this.

---

## Part 3 — Industry standards alignment

### What we get right

- **JWS-shaped tokens (RFC 7515) + EdDSA (RFC 8037).** Off-the-shelf libraries verify our tokens in any language.
- **Standard JWT claims** (`iss`, `sub`, `aud`, `exp`, `iat`, `jti`). A `cap` claim instead of `scope` is a small departure — see below.
- **JWKS-shaped key publication.** Apps can use existing JWKS-fetcher libraries.
- **Bearer token in `Authorization` header (RFC 6750)** for app→peer JWKS calls.
- **WebAuthn / passkeys** for the human-side auth — gold standard.
- **Federated, sovereign-peer model.** Conceptually aligned with ActivityPub-style federation (Mastodon, etc.) — each instance is its own IdP. No direct "standard" for this, but the pattern is well-established in modern federated systems.

### Where we diverge — should we converge?

#### 🔴 We're using deprecated implicit grant. Use authorization code + PKCE.

Already covered in security section. This is the single biggest standards-alignment issue. Switching to code + PKCE makes our flow OAuth 2.1 compliant for free.

#### 🟡 Adopt OIDC discovery (`/.well-known/openid-configuration`)

**The win:** apps could auto-configure given just a peer URL. Existing OIDC client libraries (in every language) would Just Work.

The discovery doc is a small JSON file with `issuer`, `jwks_uri`, `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint` (our `/auth/whoami`), supported algorithms, etc. Trivially small to ship.

This means an app can do `discoverPeer("https://katulong-mini.felixflor.es")` and get back everything it needs — no hand-coding peer-specific URLs.

#### 🟡 Treat our token as an OIDC `id_token`

Our JWT IS an id_token in OIDC terminology. Calling it that, and conforming to OIDC's claim conventions (`sub` is the user identifier within the issuer, `aud` is the client ID, etc. — all of which we already do), means every OIDC library handles our tokens with no custom verifier.

The "small Rust crate `katulong-token`" might not even need to exist if we just use `openid-rs` or `jose` libraries.

#### 🟡 Use `scope` (string) instead of `cap` (array)

OAuth/OIDC standardize on `scope` as a space-separated string in the claim. Renaming `cap` → `scope` and using the standard format means existing libraries parse it for us.

#### 🟡 Token introspection (RFC 7662) at `/introspect`

Our `/auth/whoami` is morally identical to RFC 7662's `/introspect`. Moving to the standard endpoint name + request/response format unlocks library support.

#### 🟢 The peer↔peer pair flow has no industry standard

This is fine — there isn't really a standard for "two operators establish mutual trust between IdPs". The closest analogs are:
- **SAML federation metadata exchange** — way too enterprise-heavy.
- **Signal's safety numbers / WhatsApp encryption code verification** — same out-of-band-fingerprint pattern as ours, well-established.
- **SSH host key trust-on-first-use** — what most people actually do.

Our bilateral passkey-confirmed model is novel but the building blocks (passkeys, fingerprint comparison, OOB channel) are all standard primitives.

#### 🟢 API key model for app↔peer

Standard practice (GitHub apps, Slack apps, every B2B SaaS). Our reuse of katulong's existing API-key flow is well-aligned.

### Standards we don't need

- **SAML.** Way too heavy. Skip.
- **OAuth 2.0 client credentials grant.** Inter-service (sipag → katulong API) is out of scope per the doc.
- **OIDC dynamic client registration.** Our app-pair flow (operator-mediated API-key issuance) is more secure than dynamic registration anyway.

---

## Top 5 recommended changes (ranked by impact)

If only five things change before the next revision:

1. **🔴 Switch implicit grant → authorization code + PKCE + `state` param.** Eliminates token-in-URL leak vectors, prevents login CSRF, brings the design to OAuth 2.1 compliance. (Security #1, #2, Industry #1.)
2. **🔴 Restrict `aud` and `return_to` based on the calling API key.** Closes the open-redirector / token-injection holes. Trivial fix. (Security #3.)
3. **🔴 Promote stable cross-peer `human_id` from "future option" to v1 requirement.** Without this, multi-peer users have a broken experience the first time they use a second peer. (UX #1.)
4. **🟡 Adopt OIDC discovery + treat tokens as OIDC `id_token`s.** Frees us from maintaining a custom verifier crate. Off-the-shelf libraries verify tokens in every language. (Industry #2, #3.)
5. **🟡 Use peer ID (UUID) as `iss` instead of peer URL, with URL discovered via a manifest.** Decouples trust from DNS / tunnel layout — peers can move without breaking app trust anchors. (Security #5.)

Items 1, 2, 4 are the same lift if done together: "make this OAuth 2.1 / OIDC-compliant." That's probably the single most valuable edit to the design.

---

## What this review is NOT

- Not a security audit by a credentialed auditor. This is one engineer's read; treat findings as a starting point, not a final answer.
- Not a re-litigation of choices already made (federated vs central, asymmetric vs symmetric, etc.). Those calls hold up well under scrutiny.
- Not a UX testing report. UX claims are based on industry pattern observation, not user studies. Real testing with the actual users (you + future stack contributors) would refine these.
