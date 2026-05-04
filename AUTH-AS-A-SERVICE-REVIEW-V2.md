# Auth-as-a-Service — round 2 review synthesis

> **Reviewing:** [`AUTH-AS-A-SERVICE.md`](./AUTH-AS-A-SERVICE.md), [`AUTH-AS-A-SERVICE-FLOWS.md`](./AUTH-AS-A-SERVICE-FLOWS.md)
> **Round 1:** [`AUTH-AS-A-SERVICE-REVIEW.md`](./AUTH-AS-A-SERVICE-REVIEW.md) (single-reviewer pass; critical findings folded back into proposal)
> **This round:** five parallel specialist reviews — security/STRIDE, vision/scope, architecture/readiness, correctness, OAuth-OIDC standards conformance.

---

## Headline verdict: **NOT READY TO SHIP**

Every one of the five reviews returned **REQUEST CHANGES** or stronger. The proposal is architecturally sound at the *concept* level (federated peers, asymmetric crypto, passkey-as-yep, OAuth-shaped flows) — but it has a hard strategic question to answer first, and a long list of specification gaps that would produce broken or insecure implementations if coded today.

**Counted blockers across the five reviews:**

| Review | Verdict | Blocking | Warnings | Acceptable |
|---|---|---|---|---|
| Vision/scope | Ship as sister project | 1 strategic | 2 | — |
| Security (STRIDE) | Request changes | 4 | 5 | 3 |
| Architecture/readiness | 2 / 5 ready | 5 gaps | — | — |
| OAuth/OIDC standards | NO — stock libs won't work | 3 fatal | 7 | — |
| Correctness | Request changes | 4 critical | 11 | — |
| **Totals** | — | **17 blocking** | **25 warnings** | **3** |

---

## The strategic question (must answer first)

The vision review's recommendation is **not** an incremental fix — it changes everything that follows:

> The problem is real; the design is sound; but **the home is wrong**. Embedding a production-grade OAuth 2.1 / OIDC authorization server inside katulong — in the same process that forks shells — violates the single-responsibility principle katulong is built on and puts IdP attack surface directly adjacent to shell access with no process boundary between them. The right move is to extract the passkey machinery into a dedicated `katulong-id` service that katulong itself delegates to (as a client, just as sipag would).

This recommendation also resolves several of the other reviews' findings for free:

- **Architecture readiness** would jump because `katulong-id` is a greenfield service with no need to entangle with `lib/auth*.js`, `isPublicPath()`, or the existing katulong middleware. Storage layout, frontend (its own static pages, not shoehorned into the terminal SPA), and module boundaries become first-class design choices instead of retrofits.
- **Security blast radius** of any auth flaw becomes "your IdP is compromised" instead of "your shell is compromised". Process isolation between the two is a free win.
- **Vision regression** disappears — katulong stays a terminal, which is what its CLAUDE.md says it is.

Cost of the sister-project path: more upfront work (new repo, new packaging, new deploy story), and katulong itself becomes a client of `katulong-id` rather than its own auth provider. Existing katulong installs would need to either bundle `katulong-id` or run it separately.

**Decision needed before continuing:** in-process (current proposal) or sister project. Everything below assumes the in-process path; if you take the sister-project path, much of the architecture-readiness work changes scope.

---

## Cross-cutting themes (issues raised by multiple reviews)

These each appeared in 2+ independent reviews — a strong signal they are real, not lint:

### 1. Peer-pair trust establishment is broken (security + correctness)
- **Security B-1:** `signed_acceptance` is verified against the public key A just sent in the same message. An attacker substitutes their own keypair, the signature checks out (because the key and signature were both attacker-supplied), and they become a paired peer.
- **Security B-2:** `/auth/mesh/pair/finalize-ack` from B to A is unauthenticated — A trusts whatever payload arrives with the right `request_id`. Same trust-anchor injection risk.
- **Correctness:** Phase 5 finalize-ack drop creates a permanently asymmetric trust state (B trusts A, A doesn't trust B). No retry, no reconciliation specified.

**Fix:** the pair-request URL must commit to a fingerprint of the expected acceptor's public key, set during Phase 1 via OOB exchange. All `/auth/mesh/pair/*` calls between peers must be signed. `finalize-ack` must be retry-safe and idempotent on `request_id`.

### 2. `same_as` is forgeable (security + correctness + standards)
- **Security B-4:** `same_as` is self-asserted by the issuing peer. A compromised peer can forge `same_as: [{iss: peer-prime, human_id: <victim>}]` without ever pairing with peer-prime, granting cross-peer impersonation.
- **Correctness:** even without compromise, a partial finalize-ack failure leaves `same_as` pointing at a `human_id_A` that A doesn't recognize, breaking apps.
- **Standards:** custom claims like `same_as` should be namespaced (`https://katulong.dorkyrobot/same_as`) per OIDC §5.1.2 to avoid future RFC collisions.

**Fix:** apps must verify `same_as` claims independently — either by calling `/auth/introspect` on the referenced peer, or by storing app-side bindings established at peer-pair time. Treat the JWT `same_as` field as a *hint* to look up an established binding, never as proof.

### 3. The "stock OIDC library" claim is currently false (standards + architecture)
- **Standards (3 fatal blockers):**
  - JWKS gated by API key — OIDC convention is unauthenticated. Stock libs 401.
  - No `id_token` in token response — proposal says "we just have one signed token", but OIDC libraries require `id_token` to be present alongside `access_token`.
  - No `nonce` handling — `oidc-client-ts` and Rust `openidconnect` always send `nonce` for code flow and reject ID tokens whose `nonce` doesn't echo back.
- Plus: missing `response_type=code` requirement at `/auth/authorize`; Bearer auth at `/auth/token` instead of `client_secret_basic`/`client_secret_post`; JSON introspection instead of form-encoded; missing required discovery fields (`response_types_supported`, `subject_types_supported`, `id_token_signing_alg_values_supported`); error responses not in standard `{error, error_description}` shape.
- **Architecture:** even within katulong, the new Bearer-API-key authentication path has no home in the existing cookie-session middleware — it has to be designed from scratch, not bolted on.

**Fix:** 10 concrete spec changes from the standards review (drop API-key gate on JWKS; emit both `id_token` and `access_token`; implement `nonce`; require `response_type=code`; switch to standard token-endpoint auth; namespace custom claims; add required discovery fields; standard error shape; PKCE charset constraints; form-encoded introspection). Without these, you ship a custom verifier crate after all.

### 4. Refresh-token reuse-detection has false-positive UX (security + correctness)
- **Security W-2 / Correctness:** legitimate retries after a network hiccup (504, TCP reset, app crash mid-rotation) look identical to token theft. Whole refresh chain gets invalidated, user is silently logged out. At a 15-minute access-token TTL with proactive refresh, this happens at scale.

**Fix:** short idempotency window — peer retains the most recent rotation result (keyed by `previous_refresh_token`) for ~30s. A retry within that window returns the already-minted tokens instead of triggering reuse-detection.

### 5. Resource leaks and cleanup are uniformly undefined (correctness + architecture)
The proposal has multiple stores (code-grant, login-pending, refresh-token, pair-request, pending-acceptance) with no specified TTLs, sweeps, or cleanup mechanisms. The architecture review notes the storage layout is undefined; the correctness review found ~5 specific leak paths. Either stores need explicit TTL+sweep contracts, or persistence/cleanup needs an end-to-end design pass.

### 6. Error handling and retry semantics under-specified (correctness + standards)
- `/auth/token` authorization_code grant is not retry-safe but the spec doesn't say so — implementors will write broken retry logic.
- `/auth/token` should re-validate API key status at exchange time (not just at `/auth/authorize`).
- `/auth/peer/jwks` 401 (revoked) vs 5xx (transient) needs explicit handling guidance — apps will get this wrong.
- "Near expiry" threshold for silent refresh undefined — every implementor picks differently.
- Crash/restart recovery for peer-pair flow unspecified — durable vs in-memory state never decided.

---

## Single-finding showstopper

**Flow 7 (failover) puts the JWT directly in the redirect URL** — `Prime->>Br: 302 https://sipag/?_kt=<jwt signed by peer-prime>`. This contradicts the central security claim of the proposal (the implicit-grant-removal that triggered the entire OAuth refactor) and is internally inconsistent with Flow 3, which uses code+PKCE for the exact same operation. Flow 7 must be brought into line with Flow 3 — failover changes which peer issues the token, nothing about the delivery mechanism.

---

## Smaller findings worth noting

- **Clock skew** on JWT `exp`/`iat` validation unaddressed — RFC 7519 §4.1.4 standard practice is ±60s tolerance.
- **`isPublicPath()` rejects `/.well-known/...`** because of the `/.` prefix check. New endpoint will hit auth middleware and break OIDC discovery.
- **Pair-request token entropy** unspecified — needs to be ≥128 bits, otherwise brute-forceable inside the TTL window.
- **`human_id` per-credential vs per-human** ambiguous — if the user deletes and re-registers a passkey, do they keep their `human_id`? Spec doesn't say.
- **API-key schema migration** — existing API keys lack `redirect_uri` / `client_id` / bound `aud`; proposal needs to discriminate "OAuth client" from "plain API key".
- **`/auth/authorize` page lifecycle** — must render before any katulong session exists. SPA route or separate static page? Decision needed before implementation.

---

## Recommended path forward

There's no single right answer, but here are the three viable paths in order of decreasing radicalism:

### Path A — Take the vision recommendation (recommended)
Spin up `katulong-id` as a sister project. Move all the proposed work there. Katulong itself becomes a client of `katulong-id` for its own login. This:
- Resolves the vision-alignment finding completely.
- Eliminates the attack-surface-co-location risk.
- Lets the new code be greenfield with its own architecture, frontend, and storage layout (architecture readiness goes from 2/5 to "design-from-scratch").
- Adds upfront cost: new repo, new deploy story, katulong has to talk to a separate process for its own auth.

### Path B — Stay in-process, fix everything, do another review round
Accept the vision risk, fold all 17 blocking findings back into the proposal, then run another parallel-review round. Realistic effort: 2-3 weeks of design work before any code is written. Even then, expect more findings on the next pass — three rounds isn't unusual for an OAuth deployment.

### Path C — Ship something narrower
Drop the cross-app federation goal for now. Just ship per-peer-passkey + per-app-API-key (already have both), and let sipag keep its duplicate WebAuthn implementation for now. Revisit the federation question once the dorky-robot stack has 3+ apps that *all* need user auth (currently it's 1: sipag). This is the "the problem isn't urgent enough yet" answer.

**My recommendation:** Path A. The vision review's argument is the strongest finding across the five reviews, and the in-process path keeps generating the same class of problems (each round of review surfaces new ones because the surface area is large and entangles with existing katulong code). Spinning up `katulong-id` as a focused project makes the design tractable and the security model cleaner.

---

## Detailed findings

For specifics on each finding, see the per-review notes captured in the orchestration thread (each agent returned ≤700 words; their full text is the authoritative version). The counts above are blocking-tier only — the warnings list is roughly twice as long.
