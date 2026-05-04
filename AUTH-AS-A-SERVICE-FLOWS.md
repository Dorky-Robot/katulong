# Auth-as-a-Service — flow diagrams

> **Companion to:** [`AUTH-AS-A-SERVICE.md`](./AUTH-AS-A-SERVICE.md)
> **Status:** draft for review.
> **Purpose:** make the proposed ceremonies concrete enough that we can argue about specific steps instead of abstract architecture.

These diagrams cover every interaction in the proposal:

1. [Peer↔peer pairing (bilateral, mutual passkey confirmation)](#1-peerpeer-pairing-bilateral)
2. [App↔peer pairing (existing API-key flow, no new ceremony)](#2-apppeer-pairing-existing-api-key-flow)
3. [First-time login (user signs in to an app)](#3-first-time-login-user-signs-in-to-an-app)
4. [Per-request verification (steady state)](#4-per-request-verification-steady-state)
5. [Token renewal (when the app's session token expires)](#5-token-renewal)
6. [JWKS refresh (kid miss / key rotation)](#6-jwks-refresh-kid-miss--key-rotation)
7. [Peer outage / failover (when the chosen peer is down)](#7-peer-outage--failover)

---

## Conventions used in these diagrams

**Actors:**

- `Op-A`, `Op-B` — the human operator at peer A or B (during a peer-peer pairing).
- `User` — the end-user signing in to an app. Same kind of human as `Op`, different role.
- `Browser` — the user's web browser. Shown as its own actor when redirects matter.
- `Peer A`, `Peer B`, `Peer P` — katulong instances. UI + server are folded into one actor; HTTP requests originate from the browser unless noted.
- `App` — a generic verifier service like sipag. Has no human at its keyboard.

**Visual conventions:**

- 🔐 **boxed regions** mark the moments where a passkey gesture is required ("yep, I'm a real human and I approve this risky action"). These are the only places the passkey appears. Outside these boxes, all trust flows over signed messages.
- `-->>` (dashed arrow) is a response.
- Notes below an arrow describe what's in the message body.

---

## 1. Peer↔peer pairing (bilateral)

**What this is:** establishing mutual trust between two katulong peers so each can verify tokens issued by the other. Both operators must passkey-confirm. A stolen pair URL alone cannot complete the ceremony.

**Trigger:** operator at one peer wants to pair with another peer they have console access to (or can get on a video call with).

```mermaid
sequenceDiagram
    actor OpB as Op-B<br/>(at Peer B)
    participant B as Peer B
    actor OpA as Op-A<br/>(at Peer A)
    participant A as Peer A

    Note over OpB,B: --- Phase 1: Initiator mints pair-request ---
    OpB->>B: click "Pair with another peer"
    B->>B: mint one-time pair token<br/>store {request_id, B_pubkey, fingerprint_B}
    B-->>OpB: display URL: https://peer-B/pair?token=...<br/>fingerprint: aaaa-bbbb-cccc

    Note over OpB,OpA: Op-B shares URL with Op-A out-of-band<br/>(SMS, Signal, in person, etc.)
    OpB->>OpA: "here's the URL + fingerprint"

    Note over OpA,A: --- Phase 2: Receiver fetches metadata ---
    OpA->>A: paste URL into "Pair with peer" form
    A->>B: GET /auth/mesh/pair/info?token=...
    B-->>A: {peer_url: peer-B, peer_name, public_keys, fingerprint, request_id}
    A-->>OpA: display "Peer B (peer-B, fp aaaa-bbbb-cccc)<br/>wants to pair. Verify the fingerprint matches<br/>what Op-B sees, then confirm."

    rect rgb(255, 245, 210)
        Note over OpA,A: 🔐 Receiver passkey gate
        OpA->>A: passkey "yep, pair with B"
        A->>A: WebAuthn assertion verified<br/>capture operator's human_id_A
    end

    Note over A,B: --- Phase 3: Receiver sends acceptance ---
    A->>A: sign acceptance with A's private peer key
    A->>B: POST /auth/mesh/pair/accept<br/>{request_id, peer_url: peer-A, peer_name,<br/>public_keys: [A's pubkey], fingerprint_A,<br/>operator_human_id: human_id_A,<br/>signed_acceptance}
    B->>B: verify A's signature against A's pubkey<br/>store pending acceptance + human_id_A
    B-->>A: 202 Accepted (pending Op-B confirmation)

    Note over OpB,B: --- Phase 4: Initiator confirms ---
    B-->>OpB: notify (SSE / poll): "Peer A (peer-A, fp xxxx-yyyy-zzzz)<br/>accepted your pair request. Verify the fingerprint<br/>matches what Op-A sees, then confirm."

    rect rgb(255, 245, 210)
        Note over OpB,B: 🔐 Initiator passkey gate
        OpB->>B: passkey "yep, finalize pair with A"
        B->>B: WebAuthn assertion verified<br/>capture operator's human_id_B
    end

    Note over A,B: --- Phase 5: Finalize + identity binding ---
    B->>B: store A's public keys + identity binding:<br/>{issuer: peer-A, public_keys, paired_at,<br/>their_human_id: human_id_A,<br/>my_human_id: human_id_B}
    B->>A: POST /auth/mesh/pair/finalize-ack<br/>{request_id, peer_url: peer-B,<br/>public_keys: [B's pubkey],<br/>operator_human_id: human_id_B}
    A->>A: store B's public keys + inverse identity binding
    A-->>B: 200 OK

    A-->>OpA: "Pairing complete with Peer B.<br/>Your accounts on both peers are linked."
    B-->>OpB: "Pairing complete with Peer A.<br/>Your accounts on both peers are linked."
```

**Why two passkey gates:**
- Without Op-A's gate: anyone who steals the pair URL can complete the ceremony from peer A's network.
- Without Op-B's gate: anyone who can talk to peer B's API (e.g. via the tunnel) can spoof an acceptance and inject themselves as a paired peer.

Both gates close the gap between "knowing the URL" and "actually approving the pair", on each side.

**Identity binding as a free byproduct:** the passkey gates identify a specific human on each peer. Since both gates fire in the same ceremony with the same human present at both ends, each peer learns the other's `human_id` for that human. From now on, tokens issued by either peer for this human carry both the local `human_id` and a `same_as` claim pointing at the other peer's `human_id`. Apps see the `same_as` and treat both as the same user — no manual user-merge UI required.

**Fingerprints displayed at both UIs:** both operators should see the *other* peer's fingerprint and verify it out-of-band ("does the URL you sent me show fingerprint `xxxx-yyyy-zzzz`?"). This catches MITM on the URL-sharing channel.

---

## 2. App↔peer pairing (existing API-key flow)

**What this is:** an app (like sipag) is told "trust this peer's tokens" by being given an API key for that peer. No new ceremony — this reuses katulong's existing API-key issuance flow, which is already passkey-gated. The "pairing" is just the operator generating an API key for the app and pasting it into the app's config.

**Trigger:** operator wants a new app to verify tokens issued by a particular peer.

```mermaid
sequenceDiagram
    actor Op as Operator
    participant P as Peer P
    participant App as App<br/>(e.g. sipag)

    Note over Op,P: --- Phase 1: Operator issues an API key for the app ---
    Op->>P: click "New API key" → app: sipag<br/>(or CLI: katulong api-key new --app sipag)

    rect rgb(255, 245, 210)
        Note over Op,P: 🔐 Existing katulong API-key passkey gate
        Op->>P: passkey "yep, issue an API key for sipag"
        P->>P: WebAuthn assertion verified
    end

    P->>P: mint API key<br/>store {api_key, app: sipag, peer_pubkeys, created_at}
    P-->>Op: display {api_key, peer_url}<br/>(api_key shown once, not stored in plaintext)

    Note over Op,App: --- Phase 2: Operator configures app ---
    Op->>App: paste {peer_url, api_key} into config<br/>(env vars or ~/.sipag/peers.json)
    Op->>App: start / restart app

    Note over App: App now considers Peer P paired.<br/>No handshake call to the peer.<br/>Trust anchor = {peer_url, api_key}.

    Note over App,P: --- Phase 3: App fetches public keys lazily (on first JWT or boot) ---
    App->>P: GET /auth/peer/jwks<br/>Authorization: Bearer <api_key>
    P->>P: validate api_key → app=sipag<br/>return current verification keys
    P-->>App: {issuer: peer-P, peer_name,<br/>keys: [{kid, alg, kty, crv, x}]}
    App->>App: cache JWKS keyed by issuer
```

**Why this is just the API-key flow, not a new ceremony:**
- Generating an API key on a peer is already a passkey-gated operation in katulong. No new "pair" UI, no new endpoint, no new state on the peer beyond what the API-key system already tracks.
- The app's trust anchor is just `{peer_url, api_key}`. The peer's URL tells the app which `iss` to trust; the API key tells the peer which app is calling.
- JWKS is fetched on-demand using the API key. Public keys aren't secret, but gating the endpoint behind the API key gives the peer per-app rate-limiting, audit logging, and revocation for free.
- Revoking an app's access = revoking its API key. Existing flow, no new logic.

---

## 3. First-time login (user signs in to an app)

**What this is:** OAuth 2.1 authorization code flow with PKCE. The user opens an app, has no session yet, gets routed through one of the app's paired peers to authenticate. The peer's existing passkey-login flow is the gate. The token is exchanged server-to-server — never traverses a URL.

**Trigger:** user navigates to `https://sipag.felixflor.es/` with no cookie.

```mermaid
sequenceDiagram
    actor User
    participant Br as Browser
    participant App as App<br/>(sipag)
    participant P as Peer<br/>(katulong-mini)

    User->>Br: open https://sipag.felixflor.es/
    Br->>App: GET /
    App->>App: no session cookie

    Note over App,Br: --- Phase 1: App renders peer picker ---
    App->>App: read peer config (paired peers: mini, prime)
    App-->>Br: 200 login.html with peer picker:<br/>[Sign in with katulong-mini]<br/>[Sign in with katulong-prime]
    Note right of App: If only one paired peer,<br/>auto-redirect (skip picker).
    Br-->>User: render picker

    User->>Br: click "Sign in with katulong-mini"
    Br->>App: GET /auth/start?peer=mini
    App->>App: generate state (random ≥128 bits)<br/>generate code_verifier (random ≥256 bits)<br/>code_challenge = base64url(SHA256(code_verifier))<br/>store {state, code_verifier, peer: mini} in<br/>login-pending table, keyed by short cookie
    App-->>Br: 302 Location: https://katulong-mini/auth/authorize<br/>?client_id=<sipag-client-id>&state=<state><br/>&code_challenge=<challenge>&code_challenge_method=S256<br/>&redirect_uri=https://sipag/auth/callback&scope=openid<br/>Set-Cookie: sipag_login_pending=<id>

    Note over Br,P: --- Phase 2: Peer validates request, runs passkey login ---
    Br->>P: GET /auth/authorize?client_id=...&state=...&code_challenge=...
    P->>P: validate client_id (known API key)<br/>validate redirect_uri matches the URL<br/>registered for this client_id<br/>(REJECT if mismatch — open redirector defense)
    P->>P: check katulong session cookie<br/>(none → run passkey ceremony)
    P-->>Br: WebAuthn challenge

    rect rgb(255, 245, 210)
        Note over User,P: 🔐 Login passkey gate<br/>("yep, approve this sipag session")
        User->>Br: select passkey, biometric / PIN
        Br->>P: WebAuthn assertion
        P->>P: verify assertion against stored credential<br/>identify user (sub, human_id)
    end

    Note over P,Br: --- Phase 3: Peer mints code (NOT a token) and redirects ---
    P->>P: mint one-time code (~30s TTL, single-use)<br/>store {code, client_id, code_challenge,<br/>user_human_id, exp}
    P-->>Br: 302 Location: https://sipag/auth/callback<br/>?code=<short_code>&state=<state>
    Note right of P: Token does NOT appear in this URL.<br/>Only the short-lived code does.

    Note over Br,App: --- Phase 4: App exchanges code for token (server-side) ---
    Br->>App: GET /auth/callback?code=<code>&state=<state><br/>Cookie: sipag_login_pending=<id>
    App->>App: lookup login-pending by cookie<br/>verify returned state == stored state<br/>(REJECT if mismatch — CSRF defense)
    App->>P: POST /auth/token<br/>Authorization: Bearer <api_key><br/>{grant_type: "authorization_code",<br/>code, code_verifier, client_id}
    P->>P: validate code (unused, not expired,<br/>bound to this client_id)<br/>verify SHA256(code_verifier) ==<br/>stored code_challenge<br/>(REJECT if PKCE mismatch — code-interception defense)
    P->>P: derive aud from API key<br/>(client cannot override)<br/>sign JWT for human_user with peer's Ed25519 key<br/>mint refresh_token
    P-->>App: 200 OK<br/>{access_token: <jwt>, refresh_token: <opaque>,<br/>expires_in: 900, token_type: "Bearer"}

    Note over App: --- Phase 5: App verifies JWT, starts session ---
    App->>App: parse JWT: kid, iss<br/>look up cached JWKS for iss<br/>verify Ed25519 signature<br/>check aud == sipag-client-id<br/>check exp > now()
    App->>App: identity = human_id from JWT<br/>(check same_as[] for known equivalents<br/>if human_id is new)
    App->>App: store {access_token, refresh_token, exp}<br/>in session table, keyed by new sipag_session cookie
    App-->>Br: 302 / Set-Cookie: sipag_session=<opaque><br/>(httpOnly, Secure, SameSite=Lax)<br/>Clear-Cookie: sipag_login_pending
    Br->>App: GET / with sipag_session cookie
    App-->>Br: 200 dashboard.html
    Br-->>User: render dashboard
```

**Where the passkey appears:** only at the peer-side login step. The token that flows back to sipag carries no passkey material — it's a peer-signed JWT. Sipag verifies it offline against cached JWKS.

**Why three layered defenses (state + PKCE + redirect_uri registration):**
- `state` defeats CSRF on the redirect-back: an attacker cannot forge a callback URL because they don't know the random `state` the app stored.
- PKCE (`code_challenge` / `code_verifier`) defeats code interception: even if an attacker observes the code in the redirect URL, they cannot exchange it without the `code_verifier`, which never leaves the app's server.
- `redirect_uri` registration defeats open-redirector: peer rejects any callback URL that doesn't match what was registered with the API key, so an attacker cannot redirect a successful login to attacker-controlled site.

**Why the token never traverses a URL:** unlike OAuth's deprecated implicit grant, the access token only appears in the response body of `/auth/token`. URL bars, browser history, `Referer` headers, and proxy logs never see it. This eliminates the entire token-leak-via-URL class of vulnerabilities.

---

## 4. Per-request verification (steady state)

**What this is:** the app has a session cookie. For each request, it pulls the cached token and verifies it. Pure local crypto — no network calls in the hot path.

```mermaid
sequenceDiagram
    actor User
    participant Br as Browser
    participant App as App<br/>(sipag)

    User->>Br: click anything
    Br->>App: GET /something<br/>Cookie: sipag_session=<opaque>
    App->>App: look up session → {access_token, refresh_token, exp}
    App->>App: verifier:<br/>1. parse header → kid, iss<br/>2. lookup peer config for iss<br/>3. lookup public key for kid (cache hit)<br/>4. Ed25519 verify<br/>5. check aud, exp<br/>6. resolve identity from human_id
    alt access_token valid
        App-->>Br: 200 response
    else access_token expired (or near expiry)
        Note over App: silent refresh — see flow 5<br/>(no redirect, no UI flash)
        App-->>Br: 200 response (after refresh)
    else access_token invalid (sig / aud mismatch)
        App-->>Br: 401 + log + clear cookie
    end
```

**Cost per request:** one map lookup (trust anchor by iss), one map lookup (key by kid), one Ed25519 verify (~50µs). Effectively free.

---

## 5. Token renewal (silent refresh-token exchange)

**What this is:** the access token has expired (default 15m). The app refreshes it server-to-server using the stored `refresh_token` — no redirect, no user interaction, the user keeps using the app uninterrupted. Standard OAuth 2.1 refresh-token rotation with reuse detection.

```mermaid
sequenceDiagram
    actor User
    participant Br as Browser
    participant App as App<br/>(sipag)
    participant P as Peer<br/>(katulong-mini)

    Br->>App: GET /something with sipag_session cookie
    App->>App: lookup session → cached {access_token, refresh_token, exp}<br/>access_token exp < now() (or near expiry)

    Note over App,P: --- Server-to-server refresh, no redirect ---
    App->>P: POST /auth/token<br/>Authorization: Bearer <api_key><br/>{grant_type: "refresh_token",<br/>refresh_token: <opaque>, client_id}

    alt refresh_token valid (unused, not expired)
        P->>P: validate refresh_token<br/>mark as used (single-use rotation)<br/>mint new access_token (15m) +<br/>new refresh_token (rotate)
        P-->>App: 200 OK<br/>{access_token: <new_jwt>,<br/>refresh_token: <new_opaque>,<br/>expires_in: 900}
        App->>App: update session table:<br/>{access_token, refresh_token, exp}
        App->>App: serve original request<br/>using new access_token
        App-->>Br: 200 response
    else refresh_token reused or expired
        P-->>App: 400 invalid_grant<br/>(reuse → invalidate entire chain)
        App->>App: clear session
        App-->>Br: 302 / Set-Cookie: sipag_session=cleared
        Note over Br,App: Falls into flow 3:<br/>full code+PKCE login.
    end
```

**Three properties of this flow:**
- **Silent:** no redirect, no passkey re-prompt, no UI flash. The user does not notice renewal.
- **Rotated:** every successful refresh returns a NEW refresh_token; the old one is invalidated.
- **Reuse-detected:** if a refresh_token is presented twice (legitimate app + attacker, or replay attack), the entire refresh chain is invalidated and the user must re-login. This catches most refresh-token-theft scenarios automatically.

The refresh_token never reaches the browser — it lives in the app's server-side session table only. An XSS in the app cannot steal it. An access-token leak (15m TTL) is the maximum exposure window.

---

## 6. JWKS refresh (kid miss / key rotation)

**What this is:** a peer rotates its signing key (every 90d, proposed). Apps that have the old `kid` cached encounter a token with an unknown `kid` and refresh.

```mermaid
sequenceDiagram
    actor User
    participant Br as Browser
    participant App as App
    participant P as Peer

    Br->>App: GET /something with sipag_session
    App->>App: parse JWT header → kid="key-v2"<br/>parse payload → iss="peer-mini"
    App->>App: lookup public key for kid in cached JWKS<br/>(only "key-v1" cached) → MISS
    App->>P: GET /auth/peer/jwks<br/>Authorization: Bearer <api_key for peer-mini>
    P->>P: validate api_key → app=sipag
    P-->>App: {issuer: peer-mini, peer_name, keys: [<br/>  {kid: "key-v1", ..., public_key},  // grace period<br/>  {kid: "key-v2", ..., public_key}   // current<br/>]}
    App->>App: update cached JWKS for iss=peer-mini<br/>find key-v2 → verify signature
    App-->>Br: 200 response
```

**Grace period:** when a peer rotates, it keeps the previous public key in JWKS for one extra rotation cycle so already-issued tokens still verify until they expire naturally. New tokens are signed with the new key.

**Failure mode:** if the peer is unreachable when an unknown `kid` appears, the app cannot verify the token. App's options: (a) reject (treat as invalid token, 401, force re-login); (b) serve stale (allow last-known cache to verify older `kid`s only — won't help here since the `kid` is unknown). Default: (a).

---

## 7. Peer outage / failover

**What this is:** sipag is paired with both `peer-mini` and `peer-prime`. The user normally logs in via `peer-mini`, but `peer-mini` is down. Sipag falls back to the picker and the user signs in via `peer-prime`.

```mermaid
sequenceDiagram
    actor User
    participant Br as Browser
    participant App as App<br/>(sipag)
    participant Mini as Peer<br/>(katulong-mini)<br/>❌ DOWN
    participant Prime as Peer<br/>(katulong-prime)

    User->>Br: open https://sipag/
    Br->>App: GET /
    App-->>Br: 302 https://katulong-mini/login?...<br/>(default: last-used peer)
    Br->>Mini: GET /login?...
    Note over Br,Mini: timeout / connection refused
    Br-->>App: error event (or back button)

    Note over App,Br: User clicks back, lands on picker again
    Br->>App: GET /
    App-->>Br: 200 login.html with peer picker<br/>[Sign in with katulong-mini ⚠ may be down]<br/>[Sign in with katulong-prime]
    Note right of App: App could probe peer health proactively<br/>(GET /auth/peer/jwks with short timeout)<br/>and grey out down peers. Optional polish.

    User->>Br: click "Sign in with katulong-prime"
    Br->>App: GET /auth/start?peer=prime
    App-->>Br: 302 https://katulong-prime/login?...

    Note over Br,Prime: Flow continues identically to flow 3,<br/>but with peer-prime as the issuer.
    Br->>Prime: GET /login?...
    Prime-->>Br: passkey challenge
    rect rgb(255, 245, 210)
        Note over User,Prime: 🔐 Login passkey at peer-prime
        User->>Br: passkey
        Br->>Prime: assertion
    end
    Prime-->>Br: 302 https://sipag/?_kt=<jwt signed by peer-prime>
    Br->>App: GET /?_kt=...
    App->>App: verify against trust anchor for iss=peer-prime
    App->>App: identity = (iss: peer-prime, sub: user-handle-at-prime)
    App-->>Br: 302 / Set-Cookie

    Note over App: Identity continuity: token from peer-prime carries<br/>human_id_prime AND same_as: [{iss: peer-mini,<br/>human_id: human_id_mini}]. Sipag already knows<br/>human_id_mini → local user, so it resolves<br/>to the SAME user. No re-login, no merge UI.<br/>(human_id binding established at peer-pair time.)
```

**Identity continuity is automatic** if the two peers were paired via the bilateral peer-pair flow (see flow 1). The pair ceremony bound the operator's `human_id`s across peers, so tokens from either peer carry `same_as[]` linking back to the other. Sipag treats them as the same user without any merge UI.

**Pre-existing tokens keep working:** if the user was already logged in before peer-mini went down, their existing access_token continues to verify (cached public key for peer-mini is still valid) until it expires (~15m). At refresh time, sipag's POST to peer-mini's `/auth/token` fails (peer down) and the user is bounced to the picker — but identity continuity via `human_id` means signing in via peer-prime puts them right back in their existing sipag session.

---

## What's not diagrammed (out of scope here)

- **Operator UI flows** (how the "Pair with another peer" button looks, how the picker is rendered). These are UX-level and belong in a separate doc once the wire flows are agreed.
- **CLI flows** (`katulong peer-token <app>`). Same shape as the UI flows minus the browser actor.
- **Logout.** Per-app: delete the app's session cookie. Per-peer: hit the peer's existing `/auth/logout`. There is no logout-everywhere broadcast (see "Out of scope" in main doc).
- **Audit log entries.** Every passkey gate should produce an audit record on the peer side. Format TBD.

---

## Things to look at while reviewing

1. **Are the bilateral pair phases right?** Specifically Phase 3 (receiver POSTs to initiator) — is the "receiver-pushes" direction correct, or should the initiator poll? Push is simpler if both peers can reach each other over the tunnel; poll is more robust if not.
2. **Phase 4's notification mechanism.** SSE on the initiator's UI? Polling? Either works — SSE is nicer UX.
3. **Fingerprint format.** Proposal: short hash of the peer's first public key, displayed as `xxxx-yyyy-zzzz`. Real users skip "compare these characters" steps (Signal-safety-number problem). Worth iterating to QR + on-device verification or 6-digit SAS in v2.
4. **Refresh-token lifetime + rotation policy.** Flow 5 uses 30d single-use rotation with reuse detection. 30d means a long-idle user re-logins at most monthly. Too short = annoying; too long = stale revocation. Match GitHub's 30d?
5. **`human_id` binding for non-operator humans.** The bilateral peer-pair binds the operators' identities for free. Other humans need a separate "bind these accounts" ceremony. Concrete UX deferred to a separate doc — for dorky-robot's actual user (one human), this isn't urgent.
6. **Peer health probing in flow 7.** Worth doing proactively to grey out down peers in the picker, or wait until users hit it?
7. **Login-pending storage.** Flow 3 stores `{state, code_verifier, peer}` in a server-side login-pending table keyed by a short browser cookie. TTL on that cookie? Proposal: 5 minutes (the user has to complete the flow within that window, otherwise restart). Cleanup of stale rows?
