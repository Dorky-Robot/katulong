# Service plan

How an eventual managed katulong offering would relate to the
open-source project, and what the user experience looks like at each
tier.

## Philosophy: protocol open, hub is product

Katulong stays open-source and self-hostable. The federation
primitives (scoped API keys, mint/consume) are a protocol — any
operator can wire up their own hub. A managed tier is just an
opinionated implementation of that protocol plus a tunnel relay for
people who don't want to operate the infrastructure themselves.

Practical consequence: if a capability belongs in the protocol, it
ships in katulong. A managed service is about convenience, not
locked-away features.

## The ladder

Three tiers are anticipated, each a superset of the previous in
convenience, not capability. Only the protocol primitives ship in
this branch; the hub implementations described here are planned but
not yet present in the repo. The only fleet CLI surface shipping
today is `katulong fleet test-mint` for operator verification.

1. **Laptop-local (planned).** `katulong fleet open` would spin up
   an ephemeral hub on localhost that iframes your registered
   instances. Zero ops, CLI-only.

2. **Self-hosted hub (planned).** `katulong hub start` would run
   the same hub as a long-lived process on any box you own. Same
   protocol as a managed tier — you run the infra.

3. **Managed hub (hypothetical).** One-passkey sign-in, unified
   carousel across your instances, auto-enrolled via the tunnel
   control plane. Same protocol as Tier 2 — an operator runs it so
   you don't have to.

## What a managed service would do

These are the capabilities a managed Tier 3 would offer — they are
not implemented today and no managed tier ships in this repo. The
sketch is included here so the open-source protocol decisions below
(scope vocabulary, cookie scoping, RP ID rules) can be reviewed
against the deployment shape they anticipate.

- **Managed tunnel relay.** Stable inbound URL for a katulong
  instance running on the operator's own hardware — the operator
  provides the host, the managed relay provides the address.
  Terminal content would stay end-to-end between browser and
  instance over a cookie-authed WebSocket; the relay terminates TLS
  but does not see plaintext PTY output.
- **Managed fleet hub.** A unified UI across multiple instances,
  authenticated with one passkey on the hub's own origin. Holds
  `mint-session`-scoped API keys for each registered instance so
  a hub click produces a first-party session on that instance.

## Multi-tenant security boundaries

**This section is load-bearing for anyone deploying katulong at a
tenant-shared apex** (the managed service, or any multi-customer
deployment you operate yourself). Getting it wrong creates
cross-tenant phishing surface.

When customer tunnels are served at `{user}.<apex>`, each subdomain
is a separate trust principal. Apex-wide primitives that feel like
UX wins on a single-user domain become vulnerabilities here.

### Rule 1 — WebAuthn RP ID stays per-origin

The fleet hub's RP ID is the hub's own origin (e.g.
`fleet.<apex>`), never the apex.

Each tunneled katulong instance keeps its own origin as its RP ID
(the default today; do not regress).

Why: an apex RP ID lets any `*.apex` page trigger a WebAuthn
ceremony that offers another customer's passkey as a candidate.
That's the exact cross-tenant phishing surface WebAuthn's origin
binding is designed to prevent. "One passkey for the fleet" is a
feature of single-principal domains, not a multi-tenant-service
one.

### Rule 2 — Session cookies stay scoped to origin

Every `katulong_session` cookie uses `Domain=<origin>`, never
`Domain=.apex`. Cookies are bearer tokens; an apex cookie crosses
the trust boundary with no ceremony at all — strictly worse than
an apex RP ID.

The federation primitives explicitly avoid this: a consume redirect
lands a cookie scoped to the consuming instance's origin, not to
any shared parent.

### Rule 3 — The hub is a distinct principal

The fleet hub is its own origin, not "part of the apex." It holds
narrow `mint-session` keys for each instance; terminal content is
still end-to-end between browser and instance over the instance's
own cookie. The hub physically cannot read shell output.

Operationally: the managed hub's origin is a separate subdomain
(e.g. `fleet.<apex>`), authenticated with its own passkey,
revocable independently from instance passkeys.

### Exception — single-principal apex

Deployments where a single party owns the entire apex (a person's
own domain, an enterprise owning theirs) are the only mode where
apex RP ID is safe. Those are a distinct BYO-domain deployment
mode — don't conflate them with the multi-tenant service apex.

## Federation primitives

The open-source pieces any hub builds on. All three shipped in
mainline katulong — the managed hub is not required to use them.

- ✅ Scoped API keys (`full`, `mint-session`; closed set, extensible).
- ✅ `POST /api/sessions/mint` — Bearer + narrow scope, returns a
  single-use consume URL. Bound to the first registered credential
  on the instance.
- ✅ `GET /auth/consume` — public, single-use, same-origin-validated,
  lands a first-party `katulong_session` cookie via 302.
- ✅ `katulong fleet test-mint` CLI helper for operator verification.
- ✅ `docs/federation-setup.md` walks an operator (or a Claude agent
  over SSH) through enabling the primitives per-instance.

Next, still open-source, to make a hub fully functional:
- `katulong fleet open` — laptop-local Tier 1 hub.
- `katulong hub start` — self-hosted Tier 2 hub, same protocol,
  run by the user.
- Optional: `mint-session` endpoint accepts a caller-label so a hub
  (managed or not) can tag mints per device/user in audit logs.

The managed hub is the only piece that's closed. It reuses the same
CLI and protocol.

## Trust properties

Properties the protocol enforces, regardless of who runs the hub:

- Keys held by a hub can only mint sessions — scope is enforced on
  your instance, not on the hub.
- Terminal content is end-to-end between your browser and your
  instance. The hub cannot read shell output.
- Revocation is one CLI command on your instance and takes effect
  immediately (`findApiKey` returns null, `auth` middleware rejects).

These are properties of the open-source primitives, not promises a
managed operator makes — they hold for self-hosted hubs too.

## Related

- `docs/federation-setup.md` — operator procedure for enabling
  `mint-session` primitives on a self-hosted instance.
- `docs/federated-chat-and-tile-sharing.md` — older parked design
  doc for cross-instance chat/tile sharing; references this plan.
